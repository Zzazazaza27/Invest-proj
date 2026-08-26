"""AI Gateway — единственная точка выхода к моделям.

У сервиса нет доступа ни к базе, ни к объектному хранилищу, ни к сессиям
пользователей: он получает задачу от core, применяет юрисдикционную политику и
возвращает результат. Всё, что он может утечь, ему сначала должны передать.

Три инварианта, которые здесь важнее производительности:

 1. **Резидентность — hard fail.** Ограниченный класс данных за пределы РФ не
    уходит. Не «подбирается другой провайдер», не «маскируется» — 403 и запись
    в журнал. Тихая деградация здесь означала бы утечку, о которой никто не
    узнает.
 2. **Недоверенный вход — только данные.** Текст заявки и материалов никогда не
    попадает в инструкции и не может изменить ни провайдера, ни класс данных.
 3. **Сервисный токен сравнивается за постоянное время.** Обычное `==` на
    секрете — это утечка по времени (`RULES.md` §3.1).
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import re
import time
import uuid
from typing import Any, Final

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from starlette.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

from .analyzer import analyze
from .llm import (
    Credential,
    ProviderError,
    assert_top_level,
    build_messages,
    build_translation_messages,
    call_chat,
    list_models,
    contains_pii,
    credential_from_env,
    load_prompts,
    new_nonce,
    parse_json_object,
)
from .policy import Policy, PolicyError, ResidencyViolation, load_policy

LOG = logging.getLogger("ai-gateway")

MAX_BODY_BYTES: Final[int] = 1_000_000


class BodyLimitMiddleware:
    """Предел тела запроса на уровне ASGI.

    Почему не обычная http-мидлварь: она получает уже собранный объект запроса,
    и подмена его `receive` до обработчика не доходит — тело успевает прочитаться
    целиком. Здесь оборачивается сам `receive`, поэтому счётчик работает раньше
    любого разбора.

    Считается ФАКТИЧЕСКИ прочитанное, а не заявленное: при chunked-передаче
    заголовка `Content-Length` нет вовсе, и проверка по нему пропускала тело
    любого размера (SEC-13).
    """

    def __init__(self, app: Any, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        received = 0
        exceeded = False

        async def counting_receive() -> dict[str, Any]:
            nonlocal received, exceeded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    exceeded = True
                    # Обрываем поток: дальше тело не читается.
                    return {"type": "http.disconnect"}
            return message

        # При превышении отдаём СВОЙ ответ целиком, а не правим чужой статус:
        # обработчик, оставшийся без тела, вернёт собственную ошибку разбора, и
        # клиент получил бы 413 с чужим телом — сообщение, по которому нельзя
        # понять причину.
        answered = False

        async def guarded_send(message: dict[str, Any]) -> None:
            nonlocal answered
            if not exceeded:
                await send(message)
                return
            if message["type"] == "http.response.start" and not answered:
                answered = True
                body = json.dumps({"code": "body_too_large"}).encode("utf-8")
                await send(
                    {
                        "type": "http.response.start",
                        "status": 413,
                        "headers": [
                            (b"content-type", b"application/json"),
                            (b"content-length", str(len(body)).encode("ascii")),
                            (b"x-content-type-options", b"nosniff"),
                            (b"referrer-policy", b"no-referrer"),
                        ],
                    }
                )
                await send({"type": "http.response.body", "body": body})

        await self.app(scope, counting_receive, guarded_send)


class BodyTooLarge(Exception):
    """Тело запроса превысило предел при потоковом чтении.

    Отдельное исключение, а не возврат ответа из обработчика чтения: прервать
    приём нужно ДО того, как тело будет разобрано, и единственный способ
    сделать это из ASGI-receive — исключение.
    """


MAX_MATERIALS: Final[int] = 50
MAX_TEXT_CHARS: Final[int] = 100_000
MIN_TOKEN_LENGTH: Final[int] = 32

# Признаки попытки перехватить инструкции. Обнаружение НИЧЕГО не меняет в
# обработке — текст и так идёт только в слот данных. Оно нужно, чтобы факт
# попытки был виден в журнале, а не растворился в обычном трафике.
INJECTION_MARKERS: Final[tuple[re.Pattern[str], ...]] = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"ignore\s+(all\s+)?(previous|prior|above)\s+instructions",
        r"disregard\s+(the\s+)?(system|previous)",
        r"игнорируй\s+(все\s+)?(предыдущие|прошлые)\s+инструкц",
        r"you\s+are\s+now\s+",
        r"system\s*:\s*",
        r"<\s*/?\s*system\s*>",
        r"jurisdiction\s*=\s*\w+",
        r"data_class\s*=\s*\w+",
    )
)


class Material(BaseModel):
    type: str = Field(max_length=64)
    text: str | None = Field(default=None, max_length=MAX_TEXT_CHARS)
    url: str | None = Field(default=None, max_length=2048)


class ProjectMetadata(BaseModel):
    """Доверенные метаданные платформы для шаблона сообщения (раздел 4 промпта)."""

    investmentAsk: str | None = Field(default=None, max_length=32)
    currency: str = Field(default="RUB", max_length=3)
    taxonomy: str | None = Field(default=None, max_length=200)
    geoCountry: str | None = Field(default=None, max_length=2)
    launchCountry: str | None = Field(default=None, max_length=2)


class ProjectPayload(BaseModel):
    title: str = Field(max_length=500)
    summary: str | None = Field(default=None, max_length=MAX_TEXT_CHARS)
    stage: str = Field(max_length=32)
    materials: list[Material] = Field(default_factory=list)
    # Одноразовый nonce прогона: только он закрывает слот данных в промпте.
    nonce: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")
    metadata: ProjectMetadata = Field(default_factory=ProjectMetadata)

    @field_validator("materials")
    @classmethod
    def _limit_materials(cls, value: list[Material]) -> list[Material]:
        if len(value) > MAX_MATERIALS:
            raise ValueError(f"материалов больше {MAX_MATERIALS}")
        return value


class ProviderCredentialPayload(BaseModel):
    """Ключ провайдера на один вызов (ADR-008 §2). В логи не попадает."""

    api_key: str = Field(min_length=8, max_length=512)
    model: str | None = Field(default=None, max_length=120)

    def __repr__(self) -> str:  # pragma: no cover - защита от случайного вывода
        return "ProviderCredentialPayload(<redacted>)"


class TranslateRequest(BaseModel):
    """Проход локализации паспорта (раздел 11): один вызов на версию паспорта."""

    provider: str = Field(max_length=64)
    provider_credential: ProviderCredentialPayload | None = None
    locale: str = Field(pattern=r"^(en-US|ru-RU)$")
    nonce: str = Field(pattern=r"^[0-9a-f]{32}$")
    numbers: dict[str, Any] = Field(default_factory=dict)
    texts: dict[str, Any]

    @field_validator("texts")
    @classmethod
    def _bounded_texts(cls, value: dict[str, Any]) -> dict[str, Any]:
        if len(json.dumps(value, ensure_ascii=False)) > 200_000:
            raise ValueError("переводимые поля больше 200 000 знаков")
        return value


class ProviderCheckRequest(BaseModel):
    """Проверка ключа из панели: провайдер из политики и ключ на один вызов."""

    provider: str = Field(max_length=64)
    provider_credential: ProviderCredentialPayload


class ProviderModelsRequest(BaseModel):
    """Каталог моделей провайдера для выбора в панели — ключ на один вызов."""

    provider: str = Field(max_length=64)
    provider_credential: ProviderCredentialPayload


class AnalyzeRequest(BaseModel):
    task: str = Field(max_length=64)
    data_class: str = Field(max_length=32)
    project: ProjectPayload
    provider: str | None = Field(default=None, max_length=64)
    provider_credential: ProviderCredentialPayload | None = None
    # Алфавит ограничен, а не только длина: trace_id пишется в лог, и
    # перевод строки в нём — подделка строки журнала чужими руками (log
    # forging, LOW внешнего аудита №2). Сейчас core присылает уже
    # санированный идентификатор, но шлюз — граница доверия и обязан
    # защищать себя сам.
    trace_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9._:-]{1,64}$")

    @field_validator("task")
    @classmethod
    def _known_task(cls, value: str) -> str:
        if value != "project_analysis":
            raise ValueError("поддерживается только task=project_analysis")
        return value


def _require_token() -> str:
    token = os.environ.get("AI_GATEWAY_TOKEN", "")
    if len(token) < MIN_TOKEN_LENGTH:
        raise RuntimeError(
            f"AI_GATEWAY_TOKEN короче {MIN_TOKEN_LENGTH} символов. "
            "Короткий сервисный токен — это дыра, а не неудобство."
        )
    return token


def create_app(policy: Policy | None = None) -> FastAPI:
    # Политика и токен проверяются на старте: неверная конфигурация должна
    # ронять сервис, а не всплывать на первом запросе с персональными данными.
    resolved_policy = policy or load_policy(
        os.environ.get("AI_POLICY_PATH", "apps/ai-gateway/policy/ai-policy.json")
    )
    expected_token = _require_token()
    # Промпт читается на старте: его отсутствие роняет сервис, а не запрос.
    prompts = load_prompts()

    # docs/redoc/openapi выключены все три. Выключить только UI недостаточно:
    # /openapi.json отдаёт ту же схему целиком и без аутентификации — то есть
    # карту внутреннего API любому, кто знает адрес.
    app = FastAPI(
        title="UNICORN AI Gateway",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.policy = resolved_policy
    # Предел тела ставится ASGI-мидлварью: она видит поток раньше, чем его
    # прочитает разбор JSON, и потому ловит запрос без Content-Length.
    app.add_middleware(BodyLimitMiddleware, max_bytes=MAX_BODY_BYTES)

    async def authenticate(authorization: str = Header(default="")) -> None:
        prefix = "Bearer "
        presented = (
            authorization[len(prefix) :] if authorization.startswith(prefix) else ""
        )
        # Сравнение в БАЙТАХ: compare_digest на str падает TypeError, если в
        # строке есть символы вне ASCII (latin-1 из заголовка), — наружу
        # уходил 500 вместо 401, а в лог трейсбек (LOW внешнего аудита №2).
        # errors="ignore" не ослабляет проверку: любой не-ASCII символ делает
        # байты заведомо отличными от токена, а токен — ASCII по построению.
        presented_bytes = presented.encode("utf-8", errors="ignore")
        expected_bytes = expected_token.encode("utf-8")
        # compare_digest и на пустой строке отработает за то же время.
        if not hmac.compare_digest(presented_bytes, expected_bytes):
            raise HTTPException(status_code=401, detail="unauthenticated")

    @app.middleware("http")
    async def limit_body(request: Request, call_next):  # type: ignore[no-untyped-def]
        declared = request.headers.get("content-length")
        if (
            declared is not None
            and declared.isdigit()
            and int(declared) > MAX_BODY_BYTES
        ):
            return JSONResponse(status_code=413, content={"code": "body_too_large"})

        response = await call_next(request)
        # Ответ шлюза не должен раскрывать стек: заголовок server ставит uvicorn.
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
        # Только статус: версия политики и имя провайдера по умолчанию —
        # бесплатная разведка для того, кто дотянулся до порта (LOW аудита №2).
        # Эти значения доступны оператору из конфигурации, а не по HTTP.
        return {"status": "ok"}

    @app.post("/v1/analyze", dependencies=[Depends(authenticate)])
    async def analyze_project(payload: AnalyzeRequest) -> dict[str, Any]:
        started = time.monotonic()
        trace_id = payload.trace_id or str(uuid.uuid4())

        try:
            provider = resolved_policy.resolve(
                payload.data_class,
                payload.provider,
                has_credential=payload.provider_credential is not None,
            )
        except ResidencyViolation as violation:
            # Отдельный код ответа: вызывающая сторона обязана отличать
            # «нельзя по закону» от «сервис занят» и не пытаться повторить.
            LOG.warning(
                "residency violation",
                extra={
                    "traceId": trace_id,
                    "dataClass": violation.data_class,
                    "provider": violation.provider,
                    "jurisdiction": violation.jurisdiction,
                },
            )
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "residency_violation",
                    "dataClass": violation.data_class,
                    "provider": violation.provider,
                    "jurisdiction": violation.jurisdiction,
                },
            ) from violation
        except PolicyError as error:
            raise HTTPException(
                status_code=422,
                detail={"code": "policy_rejected", "reason": str(error)},
            ) from error

        untrusted = "\n".join(
            [payload.project.summary or ""]
            + [m.text or "" for m in payload.project.materials]
        )
        injection_hits = [p.pattern for p in INJECTION_MARKERS if p.search(untrusted)]
        if injection_hits:
            # Поведение НЕ меняется: провайдер и класс данных уже выбраны выше,
            # до того как этот текст вообще был прочитан.
            LOG.warning(
                "prompt injection attempt in untrusted material",
                extra={"traceId": trace_id, "markers": len(injection_hits)},
            )

        # Класс данных — по СОДЕРЖИМОМУ, а не только по атрибуту проекта
        # (раздел 8, п. 11): персональные данные живут в тексте, и заявка
        # класса public с телефоном основателя не должна уехать зарубежному
        # провайдеру «легально» с точки зрения роутинга. Детекция — до вызова.
        if provider.kind != "deterministic" and contains_pii(
            f"{payload.project.title}\n{untrusted}"
        ):
            try:
                provider = resolved_policy.resolve(
                    "pdn",
                    payload.provider,
                    has_credential=payload.provider_credential is not None,
                )
            except ResidencyViolation as violation:
                LOG.warning(
                    "pii in text upgraded data class; provider rejected",
                    extra={"traceId": trace_id, "provider": violation.provider},
                )
                raise HTTPException(
                    status_code=403,
                    detail={
                        "code": "residency_violation",
                        "dataClass": "pdn",
                        "provider": violation.provider,
                        "jurisdiction": violation.jurisdiction,
                    },
                ) from violation
            except PolicyError as error:
                raise HTTPException(
                    status_code=422,
                    detail={"code": "policy_rejected", "reason": str(error)},
                ) from error

        if provider.kind != "deterministic":
            credential = (
                Credential(
                    api_key=payload.provider_credential.api_key,
                    model=payload.provider_credential.model,
                )
                if payload.provider_credential
                else credential_from_env(provider.name)
            )
            if credential is None:
                # Ключа нет ни в панели, ни в окружении — честный отказ вместо
                # тихой подмены детерминированным провайдером.
                raise HTTPException(
                    status_code=503,
                    detail={"code": "provider_unavailable", "provider": provider.name},
                )
            nonce = payload.project.nonce or new_nonce()
            model_version = (
                f"{provider.name}:{credential.model or provider.model or 'default'}"
            )
            try:
                system, user = build_messages(
                    prompts,
                    project=payload.project.model_dump(),
                    nonce=nonce,
                    model_version=model_version,
                )
                text, model_used = await run_in_threadpool(
                    call_chat,
                    endpoint=provider.endpoint or "",
                    api_style=provider.api_style,
                    auth_scheme=provider.auth_scheme,
                    credential=credential,
                    default_model=provider.model,
                    system=system,
                    user=user,
                    max_tokens=min(16000, provider.max_output_tokens),
                    temperature=0.1,
                )
                result = parse_json_object(text)
                assert_top_level(result)
            except ProviderError as error:
                LOG.warning(
                    "llm provider failed",
                    extra={
                        "traceId": trace_id,
                        "provider": provider.name,
                        "code": error.code,
                    },
                )
                status = 403 if error.code == "provider_auth" else 502
                raise HTTPException(
                    status_code=status,
                    detail={
                        "code": error.code,
                        "provider": provider.name,
                        "upstreamStatus": error.upstream_status,
                    },
                ) from error
            # Эхо модели не сохраняется, а сверяется: расхождение — рассинхрон
            # промпта и конфигурации, и его видно в журнале ядра.
            echoed = str(result.get("modelVersion", ""))
            if echoed != model_version:
                LOG.warning(
                    "modelVersion echo mismatch",
                    extra={
                        "traceId": trace_id,
                        "expected": model_version,
                        "echoed": echoed[:120],
                    },
                )
            result["modelVersion"] = f"{provider.name}:{model_used}"
            result["promptVersion"] = prompts.version
            result["provider"] = provider.name
            result["isLlm"] = True
            result["jurisdiction"] = provider.jurisdiction
            result["dataClass"] = payload.data_class
            result["traceId"] = trace_id
            result["injectionMarkers"] = len(injection_hits)
            result["durationMs"] = round((time.monotonic() - started) * 1000, 2)
            return result

        # analyze() — CPU-bound: сканирование корпуса до ~1 МБ блокирует event
        # loop на десятки-сотни мс. При одном воркере несколько параллельных
        # запросов останавливали ВСЁ, включая /healthz — каскадный отказ
        # контура (MEDIUM внешнего аудита №2). Выносится в threadpool.
        result = await run_in_threadpool(analyze, payload.project.model_dump())
        result["provider"] = provider.name
        result["isLlm"] = provider.is_llm
        result["jurisdiction"] = provider.jurisdiction
        result["dataClass"] = payload.data_class
        result["traceId"] = trace_id
        result["injectionMarkers"] = len(injection_hits)
        result["durationMs"] = round((time.monotonic() - started) * 1000, 2)
        return result

    @app.post("/v1/translate", dependencies=[Depends(authenticate)])
    async def translate_passport(payload: TranslateRequest) -> dict[str, Any]:
        """Перевод нарратива паспорта. Числа не меняются — это проверяет ядро."""
        started = time.monotonic()
        provider = resolved_policy.providers.get(payload.provider)
        enabled = provider is not None and (
            provider.enabled or payload.provider_credential is not None
        )
        if provider is None or provider.kind == "deterministic" or not enabled:
            raise HTTPException(
                status_code=503,
                detail={"code": "provider_unavailable", "provider": payload.provider},
            )
        credential = (
            Credential(
                api_key=payload.provider_credential.api_key,
                model=payload.provider_credential.model,
            )
            if payload.provider_credential
            else credential_from_env(provider.name)
        )
        if credential is None:
            raise HTTPException(
                status_code=503,
                detail={"code": "provider_unavailable", "provider": provider.name},
            )
        try:
            system, user = build_translation_messages(
                prompts,
                nonce=payload.nonce,
                locale=payload.locale,
                numbers=payload.numbers,
                texts=payload.texts,
            )
            text, model_used = await run_in_threadpool(
                call_chat,
                endpoint=provider.endpoint or "",
                api_style=provider.api_style,
                auth_scheme=provider.auth_scheme,
                credential=credential,
                default_model=provider.model,
                system=system,
                user=user,
                max_tokens=min(8000, provider.max_output_tokens),
                temperature=0,
            )
            result = parse_json_object(text)
        except ProviderError as error:
            status = 403 if error.code == "provider_auth" else 502
            raise HTTPException(
                status_code=status,
                detail={"code": error.code, "provider": provider.name},
            ) from error
        translated = result.get("translated")
        if not isinstance(translated, dict):
            raise HTTPException(
                status_code=502,
                detail={"code": "model_bad_shape", "provider": provider.name},
            )
        flags = result.get("flags") or []
        return {
            "translated": translated,
            "flags": [str(f)[:60] for f in flags if isinstance(f, str)][:10],
            "modelVersion": f"{provider.name}:{model_used}",
            "promptVersion": prompts.version,
            "provider": provider.name,
            "durationMs": round((time.monotonic() - started) * 1000, 2),
        }

    @app.post("/v1/providers/models", dependencies=[Depends(authenticate)])
    async def provider_models(payload: ProviderModelsRequest) -> dict[str, Any]:
        """Список моделей провайдера по ключу — чтобы оператор выбирал, а не угадывал.

        Имя модели, набранное руками («DeepSeek»), провайдер отвергает кодом
        400, и до первого анализа это не видно. Здесь — каталог самого
        провайдера; у кого каталога нет (YandexGPT) — статические подсказки
        из политики, и это честно помечено `source: static`.
        """
        started = time.monotonic()
        provider = resolved_policy.providers.get(payload.provider)
        if provider is None or provider.kind == "deterministic":
            raise HTTPException(status_code=422, detail={"code": "policy_rejected"})
        if provider.models_endpoint is None:
            return {
                "ok": True,
                "provider": provider.name,
                "source": "static",
                "models": list(provider.model_suggestions),
                "durationMs": round((time.monotonic() - started) * 1000, 2),
            }
        try:
            models = await run_in_threadpool(
                list_models,
                endpoint=provider.models_endpoint,
                auth_scheme=provider.auth_scheme,
                api_key=payload.provider_credential.api_key,
            )
        except ProviderError as error:
            return {
                "ok": False,
                "provider": provider.name,
                "source": "provider",
                "models": list(provider.model_suggestions),
                "code": error.code,
                "upstreamStatus": error.upstream_status,
                "durationMs": round((time.monotonic() - started) * 1000, 2),
            }
        return {
            "ok": True,
            "provider": provider.name,
            "source": "provider",
            "models": models,
            "durationMs": round((time.monotonic() - started) * 1000, 2),
        }

    @app.post("/v1/providers/check", dependencies=[Depends(authenticate)])
    async def check_provider(payload: ProviderCheckRequest) -> dict[str, Any]:
        """Проверка ключа одним коротким вызовом — без текста заявки.

        Нужна панели: оператор задал ключ и хочет знать, что он рабочий, до
        того как первый основатель запустит анализ. Вызов минимальный по
        токенам; результат — да/нет и имя модели, тело ответа наружу не идёт.
        """
        started = time.monotonic()
        provider = resolved_policy.providers.get(payload.provider)
        if provider is None or provider.kind == "deterministic":
            raise HTTPException(status_code=422, detail={"code": "policy_rejected"})
        credential = Credential(
            api_key=payload.provider_credential.api_key,
            model=payload.provider_credential.model,
        )
        try:
            text, model_used = await run_in_threadpool(
                call_chat,
                endpoint=provider.endpoint or "",
                api_style=provider.api_style,
                auth_scheme=provider.auth_scheme,
                credential=credential,
                default_model=provider.model,
                system="Отвечай только JSON.",
                user='Верни ровно {"ok": true}',
                # Рассуждающие модели (DeepSeek V4, o-серия) тратят токены на
                # размышление до первого символа ответа: 32 токена дают
                # «оборвано по лимиту» на живом ключе. 1024 — всё ещё копейки.
                max_tokens=min(1024, provider.max_output_tokens),
                temperature=0,
                timeout=30,
            )
            parsed = parse_json_object(text)
        except ProviderError as error:
            return {
                "ok": False,
                "code": error.code,
                "provider": provider.name,
                "upstreamStatus": error.upstream_status,
                "durationMs": round((time.monotonic() - started) * 1000, 2),
            }
        return {
            "ok": bool(parsed.get("ok")),
            "provider": provider.name,
            "model": model_used,
            "durationMs": round((time.monotonic() - started) * 1000, 2),
        }

    return app


def get_app() -> FastAPI:
    """Точка входа uvicorn: `uvicorn app.main:get_app --factory`.

    Модуль намеренно не создаёт приложение на импорте: тогда любой импорт (тест,
    линтер, автодополнение) требовал бы настроенного токена и валидной политики.
    Сервис же без них стартовать не должен — это обеспечивает сама фабрика.
    """
    return create_app()

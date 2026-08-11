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
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

from .analyzer import analyze
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


class ProjectPayload(BaseModel):
    title: str = Field(max_length=500)
    summary: str | None = Field(default=None, max_length=MAX_TEXT_CHARS)
    stage: str = Field(max_length=32)
    materials: list[Material] = Field(default_factory=list)

    @field_validator("materials")
    @classmethod
    def _limit_materials(cls, value: list[Material]) -> list[Material]:
        if len(value) > MAX_MATERIALS:
            raise ValueError(f"материалов больше {MAX_MATERIALS}")
        return value


class AnalyzeRequest(BaseModel):
    task: str = Field(max_length=64)
    data_class: str = Field(max_length=32)
    project: ProjectPayload
    provider: str | None = Field(default=None, max_length=64)
    trace_id: str | None = Field(default=None, max_length=128)

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
        presented = authorization[len(prefix) :] if authorization.startswith(prefix) else ""
        # compare_digest и на пустой строке отработает за то же время.
        if not hmac.compare_digest(presented, expected_token):
            raise HTTPException(status_code=401, detail="unauthenticated")

    @app.middleware("http")
    async def limit_body(request: Request, call_next):  # type: ignore[no-untyped-def]
        declared = request.headers.get("content-length")
        if declared is not None and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
            return JSONResponse(status_code=413, content={"code": "body_too_large"})

        response = await call_next(request)
        # Ответ шлюза не должен раскрывать стек: заголовок server ставит uvicorn.
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
        return {
            "status": "ok",
            "policyVersion": resolved_policy.version,
            "defaultProvider": resolved_policy.default_provider,
        }

    @app.post("/v1/analyze", dependencies=[Depends(authenticate)])
    async def analyze_project(payload: AnalyzeRequest) -> dict[str, Any]:
        started = time.monotonic()
        trace_id = payload.trace_id or str(uuid.uuid4())

        try:
            provider = resolved_policy.resolve(payload.data_class, payload.provider)
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
                status_code=422, detail={"code": "policy_rejected", "reason": str(error)}
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

        if provider.kind != "deterministic":
            # Сетевые провайдеры включаются вместе с ключами и eval-гейтом.
            # До тех пор — честный отказ вместо тихой подмены детерминированным.
            raise HTTPException(
                status_code=503,
                detail={"code": "provider_unavailable", "provider": provider.name},
            )

        result = analyze(payload.project.model_dump())
        result["provider"] = provider.name
        result["isLlm"] = provider.is_llm
        result["jurisdiction"] = provider.jurisdiction
        result["dataClass"] = payload.data_class
        result["traceId"] = trace_id
        result["injectionMarkers"] = len(injection_hits)
        result["durationMs"] = round((time.monotonic() - started) * 1000, 2)
        return result

    return app


def get_app() -> FastAPI:
    """Точка входа uvicorn: `uvicorn app.main:get_app --factory`.

    Модуль намеренно не создаёт приложение на импорте: тогда любой импорт (тест,
    линтер, автодополнение) требовал бы настроенного токена и валидной политики.
    Сервис же без них стартовать не должен — это обеспечивает сама фабрика.
    """
    return create_app()

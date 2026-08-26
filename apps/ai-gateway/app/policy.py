"""Юрисдикционная политика: загрузка, валидация, выбор провайдера.

Политика — единственное место, где решается, какому провайдеру можно отдать
класс данных. Она загружается и проверяется на старте: неверная политика роняет
сервис, а не всплывает на первом запросе с персональными данными.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Final

DATA_CLASSES: Final[frozenset[str]] = frozenset(
    {"public", "pseudonymous", "pdn", "commercial_secret"}
)

# Как разговаривать с провайдером. Закрытые списки: неизвестное значение в
# политике роняет сервис на старте, а не всплывает на первом вызове.
API_STYLES: Final[frozenset[str]] = frozenset({"openai_chat", "anthropic_messages"})
AUTH_SCHEMES: Final[frozenset[str]] = frozenset({"bearer", "api-key", "x-api-key"})


class PolicyError(RuntimeError):
    """Политика непригодна к применению. Сервис не должен стартовать."""


class ResidencyViolation(RuntimeError):
    """Запрос требует отправки ограниченных данных за пределы разрешённых юрисдикций."""

    def __init__(self, data_class: str, provider: str, jurisdiction: str) -> None:
        super().__init__(
            f"data_class={data_class} нельзя передать провайдеру {provider} "
            f"(jurisdiction={jurisdiction})"
        )
        self.data_class = data_class
        self.provider = provider
        self.jurisdiction = jurisdiction


@dataclass(frozen=True)
class Provider:
    name: str
    jurisdiction: str
    kind: str
    is_llm: bool
    endpoint: str | None
    data_classes: frozenset[str]
    enabled: bool
    # Только для сетевых провайдеров: формат запроса, способ передачи ключа и
    # модель по умолчанию (оператор может задать свою в панели).
    api_style: str = "openai_chat"
    auth_scheme: str = "bearer"
    model: str | None = None
    # Каталог моделей провайдера (GET) — для выбора модели в панели после
    # ввода ключа. Нет каталога — статический список подсказок.
    models_endpoint: str | None = None
    model_suggestions: tuple[str, ...] = ()
    # Потолок выходных токенов у провайдера: запрос выше него получает 400
    # («max_tokens is too large»), а не усечённый ответ. Шлюз режет свои
    # лимиты по нему.
    max_output_tokens: int = 16000


@dataclass(frozen=True)
class Policy:
    version: str
    default_provider: str
    restricted_classes: frozenset[str]
    allowed_jurisdictions: frozenset[str]
    providers: dict[str, Provider]

    def resolve(
        self,
        data_class: str,
        requested: str | None = None,
        *,
        has_credential: bool = False,
    ) -> Provider:
        """Выбрать провайдера под класс данных.

        `has_credential` — в запросе пришёл ключ, заданный оператором в панели
        (ADR-008 §2). Это и есть включение провайдера: `enabled` в политике
        остаётся для ключа из окружения шлюза (план ADR-007), а ключ из панели
        открывает провайдера без правки файла. Резидентность от этого не
        зависит — она проверяется раньше.

        Порядок проверок принципиален: сначала резидентность, потом всё
        остальное. Иначе запрос с персональными данными мог бы получить отказ
        «провайдер выключен» и быть повторён с другим провайдером — то есть
        нарушение выглядело бы как временная неполадка.
        """
        if data_class not in DATA_CLASSES:
            raise PolicyError(f"неизвестный класс данных: {data_class}")

        name = requested or self.default_provider
        provider = self.providers.get(name)
        if provider is None:
            raise PolicyError(f"неизвестный провайдер: {name}")

        if (
            data_class in self.restricted_classes
            and provider.jurisdiction not in self.allowed_jurisdictions
        ):
            raise ResidencyViolation(data_class, provider.name, provider.jurisdiction)

        if data_class not in provider.data_classes:
            raise ResidencyViolation(data_class, provider.name, provider.jurisdiction)

        if not provider.enabled and not has_credential:
            raise PolicyError(
                f"провайдер {provider.name} выключен: задайте ключ в панели «Подключённые API»"
            )

        return provider


def load_policy(path: str | Path) -> Policy:
    file = Path(path)
    if not file.is_file():
        raise PolicyError(f"файл политики не найден: {file}")

    try:
        raw = json.loads(file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:  # pragma: no cover - тривиально
        raise PolicyError(f"политика не разбирается как JSON: {error}") from error

    restricted = frozenset(raw.get("residency", {}).get("restricted_classes", []))
    allowed = frozenset(raw.get("residency", {}).get("allowed_jurisdictions", []))
    if not restricted or not allowed:
        raise PolicyError(
            "в политике не заданы restricted_classes или allowed_jurisdictions: "
            "пустой список означал бы разрешено всё"
        )
    unknown = restricted - DATA_CLASSES
    if unknown:
        raise PolicyError(f"неизвестные классы данных в residency: {sorted(unknown)}")

    providers: dict[str, Provider] = {}
    for entry in raw.get("providers", []):
        name = entry.get("name")
        jurisdiction = entry.get("jurisdiction")
        classes = frozenset(entry.get("data_classes", []))
        if not name or not jurisdiction:
            raise PolicyError("у провайдера нет имени или юрисдикции")
        if not classes:
            raise PolicyError(f"провайдер {name} не объявляет ни одного класса данных")
        unknown = classes - DATA_CLASSES
        if unknown:
            raise PolicyError(f"провайдер {name}: неизвестные классы {sorted(unknown)}")
        # Политика не должна содержать саму себе противоречащую строку: провайдер
        # вне разрешённых юрисдикций, которому разрешён ограниченный класс.
        if jurisdiction not in allowed and (classes & restricted):
            raise PolicyError(
                f"провайдер {name} вне {sorted(allowed)}, но ему разрешены "
                f"ограниченные классы {sorted(classes & restricted)}"
            )
        # Endpoint сетевого провайдера обязан быть https и не может быть
        # произвольной строкой из файла политики: компрометация политики иначе
        # уводила бы данные по plain http на чужой хост, а проверка
        # резидентности смотрит на поле jurisdiction, а не на адрес
        # (LOW внешнего аудита №2). Детерминированный провайдер наружу не
        # ходит — для него endpoint не требуется.
        endpoint = entry.get("endpoint")
        if entry.get("kind", "llm") != "deterministic" and endpoint is not None:
            if not isinstance(endpoint, str) or not endpoint.startswith("https://"):
                raise PolicyError(
                    f"провайдер {name!r}: endpoint обязан быть https:// (получено {endpoint!r})"
                )

        api_style = str(entry.get("api_style", "openai_chat"))
        auth_scheme = str(entry.get("auth_scheme", "bearer"))
        models_endpoint = entry.get("models_endpoint")
        if models_endpoint is not None and (
            not isinstance(models_endpoint, str)
            or not models_endpoint.startswith("https://")
        ):
            raise PolicyError(
                f"провайдер {name!r}: models_endpoint обязан быть https:// "
                f"(получено {models_endpoint!r})"
            )
        max_output_tokens = entry.get("max_output_tokens", 16000)
        if (
            not isinstance(max_output_tokens, int)
            or isinstance(max_output_tokens, bool)
            or not 2048 <= max_output_tokens <= 200_000
        ):
            raise PolicyError(
                f"провайдер {name!r}: max_output_tokens — целое от 2048 до 200000"
            )
        suggestions = entry.get("model_suggestions", [])
        if not isinstance(suggestions, list) or not all(
            isinstance(x, str) for x in suggestions
        ):
            raise PolicyError(f"провайдер {name!r}: model_suggestions — список строк")
        if entry.get("kind", "llm") != "deterministic":
            if api_style not in API_STYLES:
                raise PolicyError(
                    f"провайдер {name!r}: неизвестный api_style {api_style!r}"
                )
            if auth_scheme not in AUTH_SCHEMES:
                raise PolicyError(
                    f"провайдер {name!r}: неизвестный auth_scheme {auth_scheme!r}"
                )
            if endpoint is None:
                raise PolicyError(f"провайдер {name!r}: сетевой провайдер без endpoint")

        providers[name] = Provider(
            name=name,
            jurisdiction=jurisdiction,
            kind=entry.get("kind", "llm"),
            is_llm=bool(entry.get("is_llm", True)),
            endpoint=endpoint,
            data_classes=classes,
            # Детерминированный провайдер включён всегда: он не ходит наружу.
            enabled=bool(entry.get("enabled", entry.get("kind") == "deterministic")),
            api_style=api_style,
            auth_scheme=auth_scheme,
            models_endpoint=models_endpoint,
            model_suggestions=tuple(suggestions),
            max_output_tokens=max_output_tokens,
            model=(str(entry["model"]) if entry.get("model") else None),
        )

    default = raw.get("default_provider")
    if default not in providers:
        raise PolicyError(f"default_provider {default!r} отсутствует среди провайдеров")

    return Policy(
        version=str(raw.get("version", "0")),
        default_provider=default,
        restricted_classes=restricted,
        allowed_jurisdictions=allowed,
        providers=providers,
    )

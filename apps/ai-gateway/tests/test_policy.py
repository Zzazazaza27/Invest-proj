"""Негативные тесты юрисдикционной политики.

Зелёный тест здесь означает «нельзя»: каждый случай отвечает на вопрос
«может ли ограниченный класс данных уехать туда, куда не должен».
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.policy import Policy, PolicyError, ResidencyViolation, load_policy

POLICY_FILE = Path(__file__).resolve().parents[1] / "policy" / "ai-policy.json"


@pytest.fixture(scope="module")
def policy() -> Policy:
    return load_policy(POLICY_FILE)


def test_default_provider_is_local_and_not_llm(policy: Policy) -> None:
    provider = policy.providers[policy.default_provider]
    assert provider.jurisdiction == "RU"
    assert provider.is_llm is False


def _policy_with_ru_only_residency(tmp_path: Path) -> Path:
    """Живая политика, но с резидентностью «только РФ», как до 2026-08-26.

    Решением владельца зарубежные провайдеры в работе не ограничены
    (ADR-008 §7), поэтому механизм резидентности проверяется на фикстуре:
    он обязан оставаться работоспособным на случай возврата ограничения.
    """
    raw = json.loads(POLICY_FILE.read_text(encoding="utf-8"))
    raw["residency"]["allowed_jurisdictions"] = ["RU"]
    for provider in raw["providers"]:
        if provider["jurisdiction"] != "RU":
            provider["data_classes"] = ["public"]
            provider["enabled"] = True
    path = tmp_path / "ru-only.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    return path


@pytest.mark.parametrize("data_class", ["pdn", "commercial_secret"])
@pytest.mark.parametrize(
    "provider_name", ["anthropic", "openai", "kimi", "qwen", "deepseek"]
)
def test_restricted_classes_never_leave_ru_when_residency_is_ru_only(
    tmp_path: Path, data_class: str, provider_name: str
) -> None:
    policy = load_policy(_policy_with_ru_only_residency(tmp_path))
    with pytest.raises(ResidencyViolation):
        policy.resolve(data_class, provider_name)


def test_owner_decision_foreign_providers_get_every_class(policy: Policy) -> None:
    """Решение владельца 2026-08-26 (ADR-008 §7) зафиксировано в политике.

    Тест намеренно называет решение: если ограничение вернут, менять нужно
    и его, осознанно, а не «починить упавший тест».
    """
    foreign = [
        p for p in policy.providers.values() if p.is_llm and p.jurisdiction != "RU"
    ]
    assert {p.name for p in foreign} == {
        "anthropic",
        "openai",
        "kimi",
        "qwen",
        "deepseek",
    }
    for provider in foreign:
        assert provider.data_classes == frozenset(
            {"public", "pseudonymous", "pdn", "commercial_secret"}
        ), provider.name


def test_public_class_still_blocked_while_provider_disabled(policy: Policy) -> None:
    # Провайдер вне РФ допустим для публичных текстов, но выключен: отказ
    # обязан быть, и он не должен подменяться локальным провайдером.
    with pytest.raises(PolicyError):
        policy.resolve("public", "anthropic")


def test_unknown_provider_rejected(policy: Policy) -> None:
    with pytest.raises(PolicyError):
        policy.resolve("public", "no_such_provider")


def test_unknown_data_class_rejected(policy: Policy) -> None:
    with pytest.raises(PolicyError):
        policy.resolve("top_secret")


def test_default_resolution_works_for_every_known_class(policy: Policy) -> None:
    for data_class in ("public", "pseudonymous", "pdn", "commercial_secret"):
        assert policy.resolve(data_class).name == "local_deterministic"


def test_policy_with_contradictory_provider_is_rejected(tmp_path: Path) -> None:
    """Провайдер вне РФ с разрешёнными ПДн — не «настройка», а ошибка.

    Такая политика не должна загружаться вовсе: иначе один невнимательный
    коммит в JSON снимает защиту, и ни один тест выше этого не заметит.
    """
    raw = json.loads(POLICY_FILE.read_text(encoding="utf-8"))
    raw["residency"]["allowed_jurisdictions"] = ["RU"]
    for provider in raw["providers"]:
        if provider["name"] == "anthropic":
            provider["data_classes"] = ["public", "pdn"]
    broken = tmp_path / "broken.json"
    broken.write_text(json.dumps(raw), encoding="utf-8")

    with pytest.raises(PolicyError):
        load_policy(broken)


def test_empty_residency_section_is_rejected(tmp_path: Path) -> None:
    raw = json.loads(POLICY_FILE.read_text(encoding="utf-8"))
    raw["residency"]["restricted_classes"] = []
    broken = tmp_path / "empty.json"
    broken.write_text(json.dumps(raw), encoding="utf-8")

    with pytest.raises(PolicyError):
        load_policy(broken)


def test_missing_file_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(PolicyError):
        load_policy(tmp_path / "absent.json")

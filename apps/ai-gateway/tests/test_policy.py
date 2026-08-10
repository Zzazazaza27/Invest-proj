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


@pytest.mark.parametrize("data_class", ["pdn", "commercial_secret"])
def test_restricted_classes_never_leave_ru(policy: Policy, data_class: str) -> None:
    with pytest.raises(ResidencyViolation):
        policy.resolve(data_class, "anthropic")


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
    for provider in raw["providers"]:
        if provider["name"] == "anthropic":
            provider["data_classes"].append("pdn")
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

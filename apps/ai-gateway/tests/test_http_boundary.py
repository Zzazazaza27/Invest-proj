"""Граница HTTP шлюза: аутентификация, идентификатор трассировки, healthz.

Находки внешнего аудита №2 (Ф43):

* `hmac.compare_digest` на строке падает `TypeError`, если в заголовке
  `Authorization` есть символы вне ASCII, — наружу уходил 500 с трейсбеком в
  логе вместо честного 401;
* `trace_id` ограничивался только длиной и попадал в лог как есть: перевод
  строки в нём — подделка строки журнала чужими руками (log forging);
* `/healthz` без аутентификации раскрывал версию политики и провайдера по
  умолчанию — бесплатная разведка при выносе порта за пределы хоста.

Тестов на 401 у шлюза не было вовсе — это отдельная находка того же отчёта.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


POLICY_FILE = Path(__file__).resolve().parents[1] / "policy" / "ai-policy.json"
TOKEN = "t" * 32


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("AI_POLICY_PATH", str(POLICY_FILE))
    monkeypatch.setenv("AI_GATEWAY_TOKEN", TOKEN)
    with TestClient(create_app()) as test_client:
        yield test_client


PROJECT = {
    "task": "project_analysis",
    "data_class": "pseudonymous",
    "project": {"title": "Проект", "summary": "текст", "stage": "mvp", "materials": []},
}


def test_missing_token_is_401(client: TestClient) -> None:
    assert client.post("/v1/analyze", json=PROJECT).status_code == 401


def test_wrong_token_is_401(client: TestClient) -> None:
    response = client.post(
        "/v1/analyze", json=PROJECT, headers={"Authorization": "Bearer " + "z" * 32}
    )
    assert response.status_code == 401


def test_non_ascii_authorization_is_401_not_500(client: TestClient) -> None:
    """Не-ASCII в заголовке — отказ, а не внутренняя ошибка с трейсбеком.

    Значение передаётся БАЙТАМИ latin-1: именно так не-ASCII приходит по
    сети (HTTP-заголовки декодируются как latin-1), а str с кириллицей
    httpx отбрасывает сам, не доходя до приложения — тест был бы зелёным
    по неверной причине.
    """
    response = client.post(
        "/v1/analyze",
        json=PROJECT,
        headers={"Authorization": "Bearer pass\xe9word".encode("latin-1")},
    )
    assert response.status_code == 401


def test_valid_token_passes(client: TestClient) -> None:
    """Позитивный контроль: проверка не запрещает всё подряд."""
    response = client.post(
        "/v1/analyze", json=PROJECT, headers={"Authorization": f"Bearer {TOKEN}"}
    )
    assert response.status_code == 200
    assert response.json()["isLlm"] is False


def test_trace_id_with_newline_rejected(client: TestClient) -> None:
    """Перевод строки в trace_id отвергается разбором, а не пишется в лог."""
    payload = {**PROJECT, "trace_id": "abc\nfake-log-line"}
    response = client.post(
        "/v1/analyze", json=payload, headers={"Authorization": f"Bearer {TOKEN}"}
    )
    assert response.status_code == 422


def test_trace_id_normal_accepted(client: TestClient) -> None:
    payload = {**PROJECT, "trace_id": "01890a5d-ac96-774b-bcce-b302099a8057"}
    response = client.post(
        "/v1/analyze", json=payload, headers={"Authorization": f"Bearer {TOKEN}"}
    )
    assert response.status_code == 200


def test_healthz_does_not_leak_policy(client: TestClient) -> None:
    body = client.get("/healthz").json()
    assert body == {"status": "ok"}

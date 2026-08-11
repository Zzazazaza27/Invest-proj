"""Предел размера тела запроса, в том числе без Content-Length.

Находка внешнего аудита (SEC-13): проверка смотрела только на заголовок
`Content-Length`. При chunked-передаче его не присылают вовсе, поэтому тело
любого размера проходило к разбору JSON — то есть предел существовал только для
вежливых клиентов.

Здесь проверяется оба пути: с объявленным размером и без него.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.main import MAX_BODY_BYTES, create_app


POLICY_FILE = Path(__file__).resolve().parents[1] / "policy" / "ai-policy.json"


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    # Приложение читает путь политики и токен из окружения: без них оно не
    # стартует вовсе — и это правильное поведение, а не помеха тесту.
    monkeypatch.setenv("AI_POLICY_PATH", str(POLICY_FILE))
    monkeypatch.setenv("AI_GATEWAY_TOKEN", "x" * 32)
    with TestClient(create_app()) as test_client:
        yield test_client


def test_declared_oversized_body_rejected(client: TestClient) -> None:
    """Тело с объявленным размером больше предела отвергается."""
    payload = "x" * (MAX_BODY_BYTES + 1000)
    response = client.post(
        "/v1/analyze",
        content=payload,
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 413
    assert response.json()["code"] == "body_too_large"


def test_chunked_oversized_body_rejected(client: TestClient) -> None:
    """Тело БЕЗ Content-Length тоже отвергается: раньше оно проходило целиком."""

    def chunks() -> Iterator[bytes]:
        # Кусками по 100 КБ, суммарно заведомо больше предела. Заголовок
        # Content-Length при передаче генератором не выставляется.
        chunk = b"x" * 100_000
        for _ in range((MAX_BODY_BYTES // 100_000) + 3):
            yield chunk

    response = client.post(
        "/v1/analyze",
        content=chunks(),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 413, (
        "тело без Content-Length прошло предел: chunked-обход не закрыт"
    )
    assert response.json()["code"] == "body_too_large"


def test_normal_body_still_accepted(client: TestClient) -> None:
    """Обычный запрос не должен пострадать от проверки предела.

    Без этой проверки предыдущие две зеленели бы и при глухом отказе всему
    подряд — то есть доказывали бы не то.
    """
    body: dict[str, Any] = {
        "projectId": "00000000-0000-7000-8000-000000000001",
        "title": "Проверка предела",
        "summary": "Короткое описание проекта для проверки.",
        "stage": "mvp",
        "materials": [],
    }
    response = client.post(
        "/v1/analyze",
        content=json.dumps(body),
        headers={"Content-Type": "application/json"},
    )
    # Аутентификация или валидация могут отклонить запрос по своим причинам —
    # важно, что это НЕ 413.
    assert response.status_code != 413

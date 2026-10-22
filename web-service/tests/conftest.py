from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from web_service.config import Settings
from web_service.models import (
    ALLOWED_ENGINES,
    Category,
    EngineFailure,
    EngineId,
    OrganicResult,
)
from web_service.app import create_app


class FakeSearchAdapter:
    def __init__(self) -> None:
        self._ready: bool = True
        self._detail: str | None = None
        self._engines: list[EngineId] = list(ALLOWED_ENGINES)
        self.mock_results: list[OrganicResult] = [
            OrganicResult(
                title="Example Domain",
                url="https://example.com",
                snippet="Example domain for documentation purposes.",
                engine="duckduckgo",
            )
        ]
        self.mock_failures: list[EngineFailure] = []
        self.delay_seconds: float = 0.0
        self.search_calls: list[dict[str, Any]] = []
        self.raise_on_search: Exception | None = None

    @property
    def is_ready(self) -> bool:
        return self._ready

    @is_ready.setter
    def is_ready(self, val: bool) -> None:
        self._ready = val

    @property
    def detail(self) -> str | None:
        return self._detail

    @detail.setter
    def detail(self, val: str | None) -> None:
        self._detail = val

    @property
    def available_engines(self) -> list[EngineId]:
        return list(self._engines)

    def initialize(self) -> None:
        pass

    def search(
        self,
        query: str,
        engines: list[EngineId] | None = None,
        category: Category = "general",
        pageno: int = 1,
        timeout_ms: int = 8000,
    ) -> tuple[list[OrganicResult], list[EngineFailure]]:
        self.search_calls.append({
            "query": query,
            "engines": engines,
            "category": category,
            "pageno": pageno,
            "timeout_ms": timeout_ms,
        })
        if self.delay_seconds > 0:
            import time
            time.sleep(self.delay_seconds)
        if self.raise_on_search is not None:
            raise self.raise_on_search
        return list(self.mock_results), list(self.mock_failures)


@pytest.fixture
def test_settings(tmp_path: Path) -> Settings:
    return Settings(
        host="127.0.0.1",
        port=8766,
        token="test-secret-token-16-chars-long",
        runtime_dir=tmp_path / ".runtime",
    )


@pytest.fixture
def fake_adapter() -> FakeSearchAdapter:
    return FakeSearchAdapter()


@pytest.fixture
def app(test_settings: Settings, fake_adapter: FakeSearchAdapter):
    return create_app(test_settings, fake_adapter)


@pytest_asyncio.fixture
async def client(app) -> AsyncClient:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://127.0.0.1:8766"
    ) as client:
        yield client


@pytest.fixture
def auth_headers(test_settings: Settings) -> dict[str, str]:
    return {"Authorization": f"Bearer {test_settings.token}"}

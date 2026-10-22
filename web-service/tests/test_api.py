from __future__ import annotations

import asyncio
import logging
from typing import Any

import pytest
from httpx import AsyncClient

from web_service.models import EngineFailure, OrganicResult, UpstreamError
from tests.conftest import FakeSearchAdapter


@pytest.mark.asyncio
async def test_health_unauthorized(client: AsyncClient) -> None:
    resp = await client.get("/v1/health")
    assert resp.status_code == 401
    assert resp.json()["error"] == "unauthorized"


@pytest.mark.asyncio
async def test_health_origin_rejected(client: AsyncClient, auth_headers: dict[str, str]) -> None:
    headers = {**auth_headers, "Origin": "http://localhost:3000"}
    resp = await client.get("/v1/health", headers=headers)
    assert resp.status_code == 403
    assert resp.json()["error"] == "origin_rejected"


@pytest.mark.asyncio
async def test_health_success(client: AsyncClient, auth_headers: dict[str, str]) -> None:
    resp = await client.get("/v1/health", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["identity"] == "verbo-web"
    assert data["apiVersion"] == "1"
    assert data["ready"] is True
    assert isinstance(data["engines"], list)
    assert len(data["engines"]) == 6


@pytest.mark.asyncio
async def test_health_ready_false(
    client: AsyncClient, auth_headers: dict[str, str], fake_adapter: FakeSearchAdapter
) -> None:
    fake_adapter.is_ready = False
    fake_adapter.detail = "SearXNG failed to load"
    resp = await client.get("/v1/health", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["ready"] is False
    assert data["detail"] == "SearXNG failed to load"


@pytest.mark.asyncio
async def test_search_unauthorized(client: AsyncClient) -> None:
    resp = await client.post("/v1/search", json={"query": "test"})
    assert resp.status_code == 401
    assert resp.json()["error"] == "unauthorized"


@pytest.mark.asyncio
async def test_search_origin_rejected(client: AsyncClient, auth_headers: dict[str, str]) -> None:
    headers = {**auth_headers, "Origin": "http://localhost:3000"}
    resp = await client.post("/v1/search", json={"query": "test"}, headers=headers)
    assert resp.status_code == 403
    assert resp.json()["error"] == "origin_rejected"


@pytest.mark.asyncio
async def test_search_body_too_large(client: AsyncClient, auth_headers: dict[str, str]) -> None:
    large_query = "x" * (17 * 1024)
    resp = await client.post(
        "/v1/search",
        content=large_query.encode("utf-8"),
        headers={**auth_headers, "Content-Type": "application/json"},
    )
    assert resp.status_code == 413
    assert resp.json()["error"] == "too_large"


@pytest.mark.asyncio
async def test_search_invalid_json(client: AsyncClient, auth_headers: dict[str, str]) -> None:
    resp = await client.post(
        "/v1/search",
        content=b"not json {",
        headers={**auth_headers, "Content-Type": "application/json"},
    )
    assert resp.status_code == 422
    assert resp.json()["error"] == "invalid_request"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        {"query": ""},
        {"query": "   "},
        {"query": "x" * 2049},
        {"query": "valid", "engines": []},
        {"query": "valid", "engines": ["unknown_engine"]},
        {"query": "valid", "engines": ["duckduckgo", "duckduckgo"]},
        {"query": "valid", "category": "invalid_cat"},
        {"query": "valid", "pageno": 0},
        {"query": "valid", "pageno": 101},
        {"query": "valid", "pageno": "1"},  # strict type check: string cannot coerce to int
        {"query": "valid", "timeoutMs": 1999},
        {"query": "valid", "timeoutMs": 20001},
        {"query": "valid", "timeoutMs": "8000"},  # strict int
        {"query": "valid", "extra_field": "disallowed"},
    ],
)
async def test_search_strict_validation(
    client: AsyncClient, auth_headers: dict[str, str], payload: dict[str, Any]
) -> None:
    resp = await client.post("/v1/search", json=payload, headers=auth_headers)
    assert resp.status_code == 422
    assert resp.json()["error"] == "invalid_request"


@pytest.mark.asyncio
async def test_search_success(
    client: AsyncClient, auth_headers: dict[str, str], fake_adapter: FakeSearchAdapter
) -> None:
    fake_adapter.mock_results = [
        OrganicResult(
            title="Result 1",
            url="https://example.com/1",
            snippet="Snippet 1",
            engine="duckduckgo",
        )
    ]
    fake_adapter.mock_failures = [
        EngineFailure(engine="bing", error="timeout")
    ]

    resp = await client.post(
        "/v1/search",
        json={"query": "test query", "engines": ["duckduckgo", "bing"]},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["results"]) == 1
    assert data["results"][0]["title"] == "Result 1"
    assert len(data["unresponsiveEngines"]) == 1
    assert data["unresponsiveEngines"][0]["engine"] == "bing"


@pytest.mark.asyncio
async def test_search_busy_slot_and_health_responsiveness(
    client: AsyncClient, auth_headers: dict[str, str], fake_adapter: FakeSearchAdapter
) -> None:
    fake_adapter.delay_seconds = 0.5

    # Start first search (in background task)
    task1 = asyncio.create_task(
        client.post("/v1/search", json={"query": "first"}, headers=auth_headers)
    )

    # Allow task1 to acquire slot
    await asyncio.sleep(0.05)

    # Health must remain immediately responsive
    health_resp = await client.get("/v1/health", headers=auth_headers)
    assert health_resp.status_code == 200
    assert health_resp.json()["ready"] is True

    # Second concurrent search receives 429
    resp2 = await client.post("/v1/search", json={"query": "second"}, headers=auth_headers)
    assert resp2.status_code == 429
    assert resp2.json()["error"] == "busy"

    # Wait for first to finish
    resp1 = await task1
    assert resp1.status_code == 200


@pytest.mark.asyncio
async def test_search_all_engines_failed(
    client: AsyncClient, auth_headers: dict[str, str], fake_adapter: FakeSearchAdapter
) -> None:
    fake_adapter.raise_on_search = UpstreamError("All search engines failed.")
    resp = await client.post("/v1/search", json={"query": "fail"}, headers=auth_headers)
    assert resp.status_code == 503
    assert resp.json()["error"] == "upstream_error"


@pytest.mark.asyncio
async def test_no_raw_routes_or_docs(client: AsyncClient, auth_headers: dict[str, str]) -> None:
    r_docs = await client.get("/docs", headers=auth_headers)
    assert r_docs.status_code == 404
    r_openapi = await client.get("/openapi.json", headers=auth_headers)
    assert r_openapi.status_code == 404
    r_redoc = await client.get("/redoc", headers=auth_headers)
    assert r_redoc.status_code == 404


@pytest.mark.asyncio
async def test_logs_do_not_contain_secrets_or_query(
    client: AsyncClient,
    auth_headers: dict[str, str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    secret_query = "ultra-secret-user-query-text-xyz123"
    with caplog.at_level(logging.INFO, logger="verbo.web"):
        resp = await client.post(
            "/v1/search",
            json={"query": secret_query},
            headers=auth_headers,
        )
        assert resp.status_code == 200

    log_text = caplog.text
    assert secret_query not in log_text
    assert "test-secret-token" not in log_text
    assert "POST" in log_text
    assert "/v1/search" in log_text
    assert "200" in log_text

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import secrets
import threading
import time
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError

from web_service import API_VERSION, SERVICE_IDENTITY
from web_service.config import MAX_REQUEST_BODY_BYTES, Settings
from web_service.models import (
    BodyTooLargeError,
    BusyError,
    HealthResponse,
    InvalidRequestError,
    OrganicResult,
    EngineFailure,
    OriginRejectedError,
    ServiceSearchInput,
    ServiceSearchOutput,
    ServiceTimeoutError,
    UnauthorizedError,
    WebSearchError,
)
from web_service.searx_adapter import SearchAdapter, SearxAdapter

log = logging.getLogger("verbo.web")


def create_app(
    settings: Settings,
    adapter: SearchAdapter | None = None,
) -> FastAPI:
    settings.assert_valid()

    if adapter is None:
        settings.ensure_searxng_config()
        searx_adapter = SearxAdapter()
        searx_adapter.initialize()
        adapter = searx_adapter

    app = FastAPI(
        title="Verbo web search",
        version=API_VERSION,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    slot = asyncio.Semaphore(1)

    @app.exception_handler(WebSearchError)
    async def web_search_error(_request: Request, exc: WebSearchError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": exc.code, "detail": exc.detail},
        )

    @app.exception_handler(RequestValidationError)
    async def request_validation_error(_request: Request, _exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={"error": "invalid_request", "detail": "Request was rejected."},
        )

    @app.middleware("http")
    async def guard(request: Request, call_next: Callable[[Request], Any]) -> Response:
        started = time.perf_counter()
        if request.headers.get("origin") is not None:
            response: Response = JSONResponse(
                status_code=403,
                content={
                    "error": "origin_rejected",
                    "detail": "Browser origins cannot call the web search service.",
                },
            )
        elif not _authorized(request, settings.token):
            response = JSONResponse(
                status_code=401,
                content={
                    "error": "unauthorized",
                    "detail": "Bearer token required.",
                },
            )
        else:
            response = await call_next(request)

        elapsed_ms = int((time.perf_counter() - started) * 1000)
        log.info(
            "%s %s %s %sms",
            request.method,
            request.url.path,
            response.status_code,
            elapsed_ms,
        )
        return response

    @app.get("/v1/health")
    async def health() -> HealthResponse:
        return HealthResponse(
            identity=SERVICE_IDENTITY,
            apiVersion=API_VERSION,
            ready=adapter.is_ready,
            engines=adapter.available_engines,
            detail=adapter.detail,
        )

    @app.post("/v1/search")
    async def search(request: Request) -> ServiceSearchOutput:
        body_bytes = await _read_body(request)
        try:
            raw_data = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
            search_input = ServiceSearchInput.model_validate(raw_data)
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise InvalidRequestError("Malformed JSON payload.") from error
        except ValidationError as error:
            first_err = error.errors()[0] if error.errors() else {}
            msg = first_err.get("msg", "Validation error")
            field = ".".join(str(loc) for loc in first_err.get("loc", []))
            detail = f"{field}: {msg}" if field else msg
            raise InvalidRequestError(detail) from error

        await _acquire(slot)
        try:
            def work(_cancel: threading.Event) -> tuple[list[OrganicResult], list[EngineFailure]]:
                return adapter.search(
                    query=search_input.query,
                    engines=search_input.engines,
                    category=search_input.category,
                    pageno=search_input.pageno,
                    timeout_ms=search_input.timeoutMs,
                )

            timeout_seconds = (search_input.timeoutMs / 1000.0) + 1.0
            results, failures = await _infer(request, work, timeout_seconds)
            return ServiceSearchOutput(results=results, unresponsiveEngines=failures)
        finally:
            slot.release()

    return app


async def _read_body(request: Request) -> bytes:
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_REQUEST_BODY_BYTES:
            raise BodyTooLargeError("Request body exceeds 16 KiB.")
        chunks.append(chunk)
    return b"".join(chunks)


def _authorized(request: Request, token: str) -> bool:
    header = request.headers.get("authorization")
    if header is None or not header.startswith("Bearer ") or header[6] != " ":
        return False
    presented = header[7:].encode("utf-8")
    expected = token.encode("utf-8")
    if len(presented) != len(expected):
        secrets.compare_digest(expected, expected)
        return False
    return secrets.compare_digest(presented, expected)


async def _acquire(slot: asyncio.Semaphore) -> None:
    try:
        await asyncio.wait_for(slot.acquire(), 0.001)
    except TimeoutError as error:
        raise BusyError("The search service is already working on a request.") from error


async def _infer(
    request: Request,
    work: Callable[[threading.Event], Any],
    timeout_seconds: float,
) -> Any:
    cancel = threading.Event()
    task = asyncio.create_task(asyncio.to_thread(work, cancel))
    deadline = time.monotonic() + timeout_seconds
    try:
        while not task.done():
            if await request.is_disconnected():
                cancel.set()
            if time.monotonic() > deadline:
                cancel.set()
                raise ServiceTimeoutError("The search request timed out.")
            await asyncio.sleep(0.05)

        if cancel.is_set():
            raise ServiceTimeoutError("The search request timed out or client disconnected.")

        return await task
    finally:
        cancel.set()
        if not task.done():
            with contextlib.suppress(Exception):
                await task

from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, field_validator

EngineId = Literal["duckduckgo", "brave", "bing", "google", "wikipedia", "github"]
Category = Literal["general", "it", "science", "news"]

ALLOWED_ENGINES: tuple[EngineId, ...] = (
    "duckduckgo",
    "brave",
    "bing",
    "google",
    "wikipedia",
    "github",
)

ALLOWED_CATEGORIES: tuple[Category, ...] = (
    "general",
    "it",
    "science",
    "news",
)


class WebSearchError(Exception):
    def __init__(self, status_code: int, code: str, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.code = code
        self.detail = detail[:200]


class UnauthorizedError(WebSearchError):
    def __init__(self, detail: str = "Bearer token required.") -> None:
        super().__init__(401, "unauthorized", detail)


class OriginRejectedError(WebSearchError):
    def __init__(self, detail: str = "Browser origins cannot call the web search service.") -> None:
        super().__init__(403, "origin_rejected", detail)


class BodyTooLargeError(WebSearchError):
    def __init__(self, detail: str = "Request body exceeds 16 KiB.") -> None:
        super().__init__(413, "too_large", detail)


class InvalidRequestError(WebSearchError):
    def __init__(self, detail: str = "Invalid search request.") -> None:
        super().__init__(422, "invalid_request", detail)


class BusyError(WebSearchError):
    def __init__(self, detail: str = "The search service is busy.") -> None:
        super().__init__(429, "busy", detail)


class NotReadyError(WebSearchError):
    def __init__(self, detail: str = "The search service is not ready.") -> None:
        super().__init__(503, "not_ready", detail)


class UpstreamError(WebSearchError):
    def __init__(self, detail: str = "All search engines failed.") -> None:
        super().__init__(503, "upstream_error", detail)


class ServiceTimeoutError(WebSearchError):
    def __init__(self, detail: str = "The search request timed out.") -> None:
        super().__init__(504, "timeout", detail)


class BadResponseError(WebSearchError):
    def __init__(self, detail: str = "Malformed or oversized search response.") -> None:
        super().__init__(502, "bad_response", detail)


class ServiceSearchInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: StrictStr = Field(min_length=1, max_length=2048)
    engines: list[EngineId] | None = None
    category: Category = "general"
    pageno: StrictInt = Field(default=1, ge=1, le=100)
    timeoutMs: StrictInt = Field(default=8000, ge=2000, le=20000)

    @field_validator("query")
    @classmethod
    def validate_query(cls, v: str) -> str:
        trimmed = v.strip()
        if not trimmed:
            raise ValueError("Query must contain at least 1 non-whitespace character")
        return trimmed

    @field_validator("engines")
    @classmethod
    def validate_engines(cls, v: list[EngineId] | None) -> list[EngineId] | None:
        if v is None:
            return None
        if len(v) == 0:
            raise ValueError("Engines list cannot be empty")
        if len(v) > 6:
            raise ValueError("At most 6 engines may be specified")
        if len(set(v)) != len(v):
            raise ValueError("Duplicate engines are not permitted")
        return v


class OrganicResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: StrictStr
    url: StrictStr
    snippet: StrictStr
    engine: EngineId


class EngineFailure(BaseModel):
    model_config = ConfigDict(extra="forbid")
    engine: EngineId
    error: StrictStr = Field(max_length=200)


class ServiceSearchOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    results: list[OrganicResult]
    unresponsiveEngines: list[EngineFailure]


class HealthResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    identity: str = "verbo-web"
    apiVersion: str = "1"
    ready: bool
    engines: list[EngineId]
    detail: str | None = None


class ErrorResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    error: str
    detail: str

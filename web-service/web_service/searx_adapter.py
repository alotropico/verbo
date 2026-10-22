from __future__ import annotations

import html
import json
import logging
import os
import re
from pathlib import Path
from typing import Any, Protocol

from web_service.config import (
    DEFAULT_ACTIVE_ENGINES,
    MAX_JSON_BYTES,
    MAX_RESULTS_BATCH,
)
from web_service.models import (
    ALLOWED_CATEGORIES,
    ALLOWED_ENGINES,
    BadResponseError,
    Category,
    EngineFailure,
    EngineId,
    InvalidRequestError,
    NotReadyError,
    OrganicResult,
    UpstreamError,
)

log = logging.getLogger("verbo.web.adapter")


def configure_searx_caches(runtime_dir: Path) -> None:
    """Bind the pinned SearXNG cache factory before engine/data imports."""
    from searx.cache import ExpireCache, ExpireCacheCfg, ExpireCacheSQLite

    cache_dir = runtime_dir.resolve() / "cache"
    cache_dir.mkdir(parents=True, exist_ok=True)

    def build_cache(cfg: ExpireCacheCfg) -> ExpireCacheSQLite:
        cfg.db_url = str(cache_dir / f"sxng_cache_{ExpireCache.normalize_name(cfg.name)}.db")
        return ExpireCacheSQLite(cfg)

    ExpireCache.build_cache = staticmethod(build_cache)


class SearchAdapter(Protocol):
    @property
    def is_ready(self) -> bool: ...

    @property
    def detail(self) -> str | None: ...

    @property
    def available_engines(self) -> list[EngineId]: ...

    def initialize(self) -> None: ...

    def search(
        self,
        query: str,
        engines: list[EngineId] | None = None,
        category: Category = "general",
        pageno: int = 1,
        timeout_ms: int = 8000,
    ) -> tuple[list[OrganicResult], list[EngineFailure]]: ...


class SearxAdapter:
    def __init__(self) -> None:
        self._ready: bool = False
        self._detail: str | None = "Initializing..."
        self._engines: list[EngineId] = list(ALLOWED_ENGINES)
        self._flask_app: Any = None

    @property
    def is_ready(self) -> bool:
        return self._ready

    @property
    def detail(self) -> str | None:
        return self._detail

    @property
    def available_engines(self) -> list[EngineId]:
        return list(self._engines)

    def initialize(self) -> None:
        try:
            from searx import init_settings, settings
            init_settings()
            configure_searx_caches(Path(os.environ["SEARXNG_SETTINGS_PATH"]).parent)

            # Filter engines strictly to the six allowed engines
            filtered_engines: list[dict[str, Any]] = [
                e for e in settings.get("engines", []) if e.get("name") in ALLOWED_ENGINES
            ]

            # All allowed engines need processors; disabled only controls defaults.
            for e in filtered_engines:
                name = e.get("name")
                e["inactive"] = False
                e["disabled"] = name not in DEFAULT_ACTIVE_ENGINES

            settings["engines"] = filtered_engines

            from searx.search import initialize as searx_initialize
            searx_initialize(settings_engines=filtered_engines, enable_metrics=False)

            from flask import Flask
            self._flask_app = Flask("verbo_searx_adapter")

            self._ready = True
            self._detail = None
            log.info("SearxAdapter successfully initialized with engines: %s", [e["name"] for e in filtered_engines])
        except Exception as error:
            self._ready = False
            self._detail = str(error)[:200]
            log.error("Failed to initialize SearxAdapter: %s", error)

    def search(
        self,
        query: str,
        engines: list[EngineId] | None = None,
        category: Category = "general",
        pageno: int = 1,
        timeout_ms: int = 8000,
    ) -> tuple[list[OrganicResult], list[EngineFailure]]:
        if not self._ready:
            raise NotReadyError(self._detail or "Search engine adapter is not ready.")

        if category not in ALLOWED_CATEGORIES:
            raise InvalidRequestError(f"Category '{category}' is not supported.")

        # Determine requested engine order
        if engines is None or len(engines) == 0:
            requested_engines: list[EngineId] = list(DEFAULT_ACTIVE_ENGINES)
        else:
            requested_engines = list(engines)

        # Validate engine IDs
        for eng in requested_engines:
            if eng not in ALLOWED_ENGINES:
                raise InvalidRequestError(f"Engine '{eng}' is not recognized.")

        import searx.engines
        from searx.search import Search
        from searx.search.models import EngineRef, SearchQuery

        active_engine_refs: list[EngineRef] = []
        unresponsive_failures: list[EngineFailure] = []

        for eng_name in requested_engines:
            eng_obj = searx.engines.engines.get(eng_name)
            declared_categories = getattr(eng_obj, "categories", []) if eng_obj else []

            if category == "general":
                primary_cat = declared_categories[0] if declared_categories else "general"
                active_engine_refs.append(EngineRef(eng_name, primary_cat))
            else:
                if category in declared_categories:
                    active_engine_refs.append(EngineRef(eng_name, category))
                else:
                    unresponsive_failures.append(
                        EngineFailure(engine=eng_name, error="unsupported_category")
                    )

        if not active_engine_refs:
            raise InvalidRequestError(
                f"No selected engine supports the requested category '{category}'."
            )

        timeout_seconds = timeout_ms / 1000.0

        with self._flask_app.test_request_context("/"):
            sq = SearchQuery(
                query=query,
                engineref_list=active_engine_refs,
                pageno=pageno,
                timeout_limit=timeout_seconds,
            )
            search_instance = Search(sq)
            result_container = search_instance.search()
            ordered_raw_results = result_container.get_ordered_results()

        # Capture engine failures from result container
        for item in result_container.unresponsive_engines:
            eng = getattr(item, "engine", None)
            err = getattr(item, "error_type", "engine_error")
            if eng in ALLOWED_ENGINES:
                unresponsive_failures.append(
                    EngineFailure(engine=eng, error=str(err)[:200])
                )

        # Deduplicate unresponsive failures preserving first error per engine
        seen_failed_engines: set[EngineId] = set()
        deduped_failures: list[EngineFailure] = []
        for f in unresponsive_failures:
            if f.engine not in seen_failed_engines:
                seen_failed_engines.add(f.engine)
                deduped_failures.append(f)

        results: list[OrganicResult] = []
        for r in ordered_raw_results:
            title = getattr(r, "title", None)
            url = getattr(r, "url", None)
            if not title or not url or not isinstance(title, str) or not isinstance(url, str):
                continue

            template = getattr(r, "template", "")
            if template in ("images", "videos"):
                continue

            # Strip HTML tags, unescape HTML entities, and collapse whitespace
            title_clean = " ".join(html.unescape(re.sub(r"<[^>]+>", " ", title)).split())
            if not title_clean:
                continue

            raw_content = getattr(r, "content", "") or ""
            snippet_clean = " ".join(html.unescape(re.sub(r"<[^>]+>", " ", str(raw_content))).split())

            # Resolve engine: for merged results, pick first contributing engine in request order
            contributing = getattr(r, "engines", set()) or set()
            resolved_engine: EngineId | None = None
            for req_eng in requested_engines:
                if req_eng in contributing:
                    resolved_engine = req_eng
                    break
            if resolved_engine is None:
                primary = getattr(r, "engine", None)
                if primary in ALLOWED_ENGINES:
                    resolved_engine = primary
                else:
                    continue

            results.append(
                OrganicResult(
                    title=title_clean,
                    url=url,
                    snippet=snippet_clean,
                    engine=resolved_engine,
                )
            )

        if len(results) > MAX_RESULTS_BATCH:
            raise BadResponseError(
                f"Batch result count ({len(results)}) exceeds maximum limit of {MAX_RESULTS_BATCH}."
            )

        # If every applicable engine failed and no results were returned
        queried_engine_names = {ref.name for ref in active_engine_refs}
        failed_engine_names = {f.engine for f in deduped_failures}
        if len(results) == 0 and queried_engine_names.issubset(failed_engine_names):
            raise UpstreamError("All queried engines failed or timed out.")

        # Validate JSON serialization size
        serialized_bytes = json.dumps([res.model_dump() for res in results]).encode("utf-8")
        if len(serialized_bytes) > MAX_JSON_BYTES:
            raise BadResponseError("Serialized search results exceed 2 MiB.")

        return results, deduped_failures

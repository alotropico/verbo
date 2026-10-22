from __future__ import annotations

import os
from pathlib import Path

import pytest

from web_service.config import Settings
from web_service.models import ALLOWED_ENGINES
from web_service.searx_adapter import SearxAdapter

IS_LIVE = os.environ.get("VERBO_WEB_LIVE") == "1"


@pytest.mark.skipif(not IS_LIVE, reason="Live network search test requires VERBO_WEB_LIVE=1")
def test_live_imported_searxng_search(tmp_path: Path) -> None:
    settings = Settings(
        host="127.0.0.1",
        port=8766,
        token="test-live-search-token-16-chars",
        runtime_dir=tmp_path / "runtime",
    )
    settings.ensure_searxng_config()

    adapter = SearxAdapter()
    adapter.initialize()
    assert adapter.is_ready is True

    # Search with reliable general engines
    results, failures = adapter.search(
        query="python programming language",
        engines=["wikipedia", "brave", "bing"],
        category="general",
        pageno=1,
        timeout_ms=10000,
    )

    # Must return at least one organic live result
    assert len(results) > 0
    first = results[0]
    assert first.title
    assert first.url.startswith("http://") or first.url.startswith("https://")
    assert first.engine in ALLOWED_ENGINES

    # Partial failures must be visible as structured EngineFailure items
    assert isinstance(failures, list)
    for f in failures:
        assert f.engine in ALLOWED_ENGINES
        assert len(f.error) <= 200

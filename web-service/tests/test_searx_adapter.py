from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from web_service.config import Settings
from web_service.models import (
    BadResponseError,
    EngineFailure,
    InvalidRequestError,
    NotReadyError,
    UpstreamError,
)
from web_service.searx_adapter import SearxAdapter


@pytest.fixture(scope="module")
def initialized_adapter(tmp_path_factory: pytest.TempPathFactory) -> SearxAdapter:
    tmp_path = tmp_path_factory.mktemp("adapter_test")
    settings = Settings(
        host="127.0.0.1",
        port=8766,
        token="adapter-secret-token-16-chars",
        runtime_dir=tmp_path / "runtime",
    )
    settings.ensure_searxng_config()
    adapter = SearxAdapter()
    adapter.initialize()
    return adapter


def test_adapter_readiness(initialized_adapter: SearxAdapter) -> None:
    assert initialized_adapter.is_ready is True
    assert initialized_adapter.detail is None
    assert len(initialized_adapter.available_engines) == 6


def test_initialized_searx_caches_use_the_service_runtime(initialized_adapter: SearxAdapter) -> None:
    import os
    from searx.data import get_cache
    from searx.enginelib import ENGINES_CACHE

    expected = Path(os.environ["SEARXNG_SETTINGS_PATH"]).parent.resolve() / "cache"
    assert Path(ENGINES_CACHE.cfg.db_url).parent == expected
    assert Path(get_cache().cfg.db_url).parent == expected


def test_google_is_loaded_and_queried_only_when_requested(initialized_adapter: SearxAdapter) -> None:
    from searx.engines import engines

    assert "google" in engines
    assert engines["google"].inactive is False
    assert engines["google"].disabled is True
    fake_container = MagicMock()
    fake_container.get_ordered_results.return_value = []
    fake_container.unresponsive_engines = []
    with patch("searx.search.Search", autospec=True) as search:
        search.return_value.search.return_value = fake_container
        initialized_adapter.search("explicit", engines=["google"])
        assert [ref.name for ref in search.call_args.args[0].engineref_list] == ["google"]
        initialized_adapter.search("defaults")
        assert "google" not in [ref.name for ref in search.call_args.args[0].engineref_list]


def test_adapter_search_when_not_ready() -> None:
    adapter = SearxAdapter()
    with pytest.raises(NotReadyError) as exc_info:
        adapter.search("test")
    assert "Initializing" in str(exc_info.value) or "not ready" in str(exc_info.value)


def test_adapter_category_unsupported_all(initialized_adapter: SearxAdapter) -> None:
    # None of duckduckgo or bing support 'science'
    with pytest.raises(InvalidRequestError) as exc_info:
        initialized_adapter.search(
            query="quantum",
            engines=["duckduckgo", "bing"],
            category="science",
        )
    assert "supports the requested category" in str(exc_info.value)


def test_adapter_category_partial_support(initialized_adapter: SearxAdapter) -> None:
    # github supports 'it', duckduckgo does not
    # We mock Search.search() to isolate category filtering logic
    fake_result_container = MagicMock()
    fake_result_container.get_ordered_results.return_value = []
    fake_result_container.unresponsive_engines = []

    with patch("searx.search.Search.search", return_value=fake_result_container):
        results, failures = initialized_adapter.search(
            query="python",
            engines=["github", "duckduckgo"],
            category="it",
        )

    # duckduckgo was skipped because it doesn't support 'it'
    assert any(f.engine == "duckduckgo" and f.error == "unsupported_category" for f in failures)


def test_adapter_merged_engine_request_order(initialized_adapter: SearxAdapter) -> None:
    raw_result = MagicMock()
    raw_result.title = "Example Title"
    raw_result.url = "https://example.com"
    raw_result.content = "Example content with <b>tags</b> &amp; entities."
    raw_result.template = "default"
    raw_result.engines = {"brave", "bing"}
    raw_result.engine = "bing"

    fake_result_container = MagicMock()
    fake_result_container.get_ordered_results.return_value = [raw_result]
    fake_result_container.unresponsive_engines = []

    with patch("searx.search.Search.search", return_value=fake_result_container):
        # When brave is first in request order
        results_brave_first, _ = initialized_adapter.search(
            query="test",
            engines=["brave", "bing"],
        )
        assert results_brave_first[0].engine == "brave"

        # When bing is first in request order
        results_bing_first, _ = initialized_adapter.search(
            query="test",
            engines=["bing", "brave"],
        )
        assert results_bing_first[0].engine == "bing"


def test_adapter_plain_text_snippet_and_filtering(initialized_adapter: SearxAdapter) -> None:
    valid_res = MagicMock()
    valid_res.title = "  Clean &lt;b&gt;Title&lt;/b&gt;  "
    valid_res.url = "https://example.com"
    valid_res.content = "Snippet with <span>HTML</span> and   multiple    spaces &amp; symbols."
    valid_res.template = "default"
    valid_res.engines = {"duckduckgo"}
    valid_res.engine = "duckduckgo"

    image_res = MagicMock()
    image_res.title = "Image"
    image_res.url = "https://example.com/img.jpg"
    image_res.template = "images"  # Should be dropped
    image_res.engines = {"duckduckgo"}

    fake_result_container = MagicMock()
    fake_result_container.get_ordered_results.return_value = [valid_res, image_res]
    fake_result_container.unresponsive_engines = []

    with patch("searx.search.Search.search", return_value=fake_result_container):
        results, _ = initialized_adapter.search(
            query="test",
            engines=["duckduckgo"],
        )

    assert len(results) == 1
    assert results[0].title == "Clean <b>Title</b>"
    assert results[0].snippet == "Snippet with HTML and multiple spaces & symbols."


def test_adapter_all_queried_engines_failed_raises_upstream(initialized_adapter: SearxAdapter) -> None:
    fake_failure = MagicMock()
    fake_failure.engine = "duckduckgo"
    fake_failure.error_type = "ConnectionError"

    fake_result_container = MagicMock()
    fake_result_container.get_ordered_results.return_value = []
    fake_result_container.unresponsive_engines = [fake_failure]

    with patch("searx.search.Search.search", return_value=fake_result_container):
        with pytest.raises(UpstreamError) as exc_info:
            initialized_adapter.search(query="test", engines=["duckduckgo"])
        assert "All queried engines failed" in str(exc_info.value)


def test_adapter_batch_overflow_raises_bad_response(initialized_adapter: SearxAdapter) -> None:
    # 201 results exceeds MAX_RESULTS_BATCH = 200
    many_results = []
    for i in range(201):
        r = MagicMock()
        r.title = f"Title {i}"
        r.url = f"https://example.com/{i}"
        r.content = f"Snippet {i}"
        r.template = "default"
        r.engines = {"duckduckgo"}
        r.engine = "duckduckgo"
        many_results.append(r)

    fake_result_container = MagicMock()
    fake_result_container.get_ordered_results.return_value = many_results
    fake_result_container.unresponsive_engines = []

    with patch("searx.search.Search.search", return_value=fake_result_container):
        with pytest.raises(BadResponseError) as exc_info:
            initialized_adapter.search(query="test", engines=["duckduckgo"])
        assert "exceeds maximum limit" in str(exc_info.value)

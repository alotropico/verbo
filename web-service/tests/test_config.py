from __future__ import annotations

import os
from pathlib import Path

import pytest
import yaml

from web_service.config import Settings, load_settings
from web_service.models import ALLOWED_ENGINES


def test_assert_valid_refuses_non_loopback(tmp_path: Path) -> None:
    settings = Settings(
        host="0.0.0.0",
        port=8766,
        token="test-secret-token-16-chars-long",
        runtime_dir=tmp_path,
    )
    with pytest.raises(SystemExit) as exc_info:
        settings.assert_valid()
    assert "Refusing to bind" in str(exc_info.value)


def test_assert_valid_refuses_invalid_port(tmp_path: Path) -> None:
    settings = Settings(
        host="127.0.0.1",
        port=0,
        token="test-secret-token-16-chars-long",
        runtime_dir=tmp_path,
    )
    with pytest.raises(SystemExit) as exc_info:
        settings.assert_valid()
    assert "Refusing web search port" in str(exc_info.value)

    settings_high = Settings(
        host="127.0.0.1",
        port=70000,
        token="test-secret-token-16-chars-long",
        runtime_dir=tmp_path,
    )
    with pytest.raises(SystemExit) as exc_info:
        settings_high.assert_valid()
    assert "Refusing web search port" in str(exc_info.value)


def test_assert_valid_refuses_short_token(tmp_path: Path) -> None:
    settings = Settings(
        host="127.0.0.1",
        port=8766,
        token="short",
        runtime_dir=tmp_path,
    )
    with pytest.raises(SystemExit) as exc_info:
        settings.assert_valid()
    assert "at least 16 characters" in str(exc_info.value)


def test_assert_valid_refuses_multiline_token(tmp_path: Path) -> None:
    settings = Settings(
        host="127.0.0.1",
        port=8766,
        token="token-with-newline\n12345678",
        runtime_dir=tmp_path,
    )
    with pytest.raises(SystemExit) as exc_info:
        settings.assert_valid()
    assert "newline" in str(exc_info.value)


def test_assert_valid_accepts_valid_settings(tmp_path: Path) -> None:
    settings = Settings(
        host="127.0.0.1",
        port=8766,
        token="valid-secret-token-at-least-16-chars",
        runtime_dir=tmp_path,
    )
    settings.assert_valid()


def test_load_settings_from_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VERBO_WEB_HOST", "127.0.0.1")
    monkeypatch.setenv("VERBO_WEB_PORT", "9999")
    monkeypatch.setenv("VERBO_WEB_TOKEN", "my-long-token-for-testing-123456")
    monkeypatch.setenv("VERBO_WEB_RUNTIME_DIR", str(tmp_path / "custom_runtime"))

    s = load_settings()
    assert s.host == "127.0.0.1"
    assert s.port == 9999
    assert s.token == "my-long-token-for-testing-123456"
    assert s.runtime_dir == tmp_path / "custom_runtime"


def test_load_settings_invalid_port_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VERBO_WEB_PORT", "not-a-number")
    with pytest.raises(SystemExit) as exc_info:
        load_settings()
    assert "not an integer" in str(exc_info.value)


def test_ensure_searxng_config_generates_file(tmp_path: Path) -> None:
    settings = Settings(
        host="127.0.0.1",
        port=8766,
        token="secret-token-for-searxng-generation-123",
        runtime_dir=tmp_path / "runtime",
    )
    path = settings.ensure_searxng_config()
    assert path.is_file()
    assert os.environ.get("SEARXNG_SETTINGS_PATH") == str(path)
    assert os.environ.get("SEARXNG_DISABLE_ETC_SETTINGS") == "1"

    with open(path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)

    assert data["use_default_settings"]["engines"]["keep_only"] == list(ALLOWED_ENGINES)
    assert data["server"]["limiter"] is False
    assert data["server"]["public_instance"] is False
    assert data["server"]["image_proxy"] is False
    assert data["search"]["formats"] == ["json"]
    assert len(data["server"]["secret_key"]) == 64


def test_searx_cache_factory_keeps_each_runtime_isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    settings = Settings("127.0.0.1", 8766, "cache-test-token-at-least-16-chars", tmp_path / "runtime")
    settings.ensure_searxng_config()
    from searx.cache import ExpireCache, ExpireCacheCfg
    from web_service.searx_adapter import configure_searx_caches

    monkeypatch.setattr(ExpireCache, "build_cache", staticmethod(ExpireCache.build_cache))
    configure_searx_caches(settings.runtime_dir)
    first = ExpireCache.build_cache(ExpireCacheCfg(name="ENGINES_CACHE"))
    data = ExpireCache.build_cache(ExpireCacheCfg(name="DATA_CACHE"))
    expected = settings.runtime_dir.resolve() / "cache"
    assert Path(first.cfg.db_url).parent == expected
    assert Path(data.cfg.db_url).parent == expected

    configure_searx_caches(tmp_path / "second-runtime")
    second = ExpireCache.build_cache(ExpireCacheCfg(name="ENGINES_CACHE"))
    assert first.cfg.db_url != second.cfg.db_url
    assert Path(first.cfg.db_url).parent == expected
    assert Path(second.cfg.db_url).parent == tmp_path / "second-runtime" / "cache"

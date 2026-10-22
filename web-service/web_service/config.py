from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from web_service.models import ALLOWED_ENGINES

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8766
DEFAULT_ACTIVE_ENGINES: tuple[str, ...] = ("duckduckgo", "brave", "bing", "wikipedia", "github")
MAX_REQUEST_BODY_BYTES = 16 * 1024
MAX_RESULTS_BATCH = 200
MAX_JSON_BYTES = 2 * 1024 * 1024


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    token: str
    runtime_dir: Path

    def assert_valid(self) -> None:
        if self.host != DEFAULT_HOST:
            raise SystemExit(
                f"Refusing to bind {self.host}. The web search service listens on {DEFAULT_HOST} only."
            )
        if self.port < 1 or self.port > 65535:
            raise SystemExit(f"Refusing web search port {self.port}.")
        if len(self.token) < 16:
            raise SystemExit(
                "Set VERBO_WEB_TOKEN before starting (must be at least 16 characters). "
                "The supervisor writes %LOCALAPPDATA%\\Verbo\\web-token and passes it."
            )
        if "\n" in self.token or "\r" in self.token:
            raise SystemExit("VERBO_WEB_TOKEN must not contain newline characters.")

    def ensure_searxng_config(self) -> Path:
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        settings_file = self.runtime_dir / "settings.yml"

        secret_source = f"verbo-web-searxng-secret:{self.token}".encode("utf-8")
        secret_key = hashlib.sha256(secret_source).hexdigest()

        config: dict[str, Any] = {
            "use_default_settings": {
                "engines": {
                    "keep_only": list(ALLOWED_ENGINES)
                }
            },
            "server": {
                "secret_key": secret_key,
                "limiter": False,
                "public_instance": False,
                "image_proxy": False,
            },
            "search": {
                "formats": ["json"],
                "autocomplete": "",
            },
            "outgoing": {
                "request_timeout": 20.0,
                "max_request_timeout": 20.0,
            },
            "metrics": {
                "enable": False,
            },
            "plugins": {},
        }

        with open(settings_file, "w", encoding="utf-8") as f:
            yaml.safe_dump(config, f)

        os.environ["SEARXNG_SETTINGS_PATH"] = str(settings_file)
        os.environ["SEARXNG_DISABLE_ETC_SETTINGS"] = "1"
        return settings_file


def load_settings() -> Settings:
    host = os.environ.get("VERBO_WEB_HOST", DEFAULT_HOST)
    raw_port = os.environ.get("VERBO_WEB_PORT", str(DEFAULT_PORT))
    try:
        port = int(raw_port)
    except ValueError as error:
        raise SystemExit(f"VERBO_WEB_PORT is not an integer: {raw_port}") from error

    token = os.environ.get("VERBO_WEB_TOKEN", "")
    runtime_dir_env = os.environ.get("VERBO_WEB_RUNTIME_DIR")
    runtime_dir = Path(runtime_dir_env) if runtime_dir_env else ROOT / ".runtime"

    return Settings(
        host=host,
        port=port,
        token=token,
        runtime_dir=runtime_dir,
    )

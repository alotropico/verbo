from __future__ import annotations

import uvicorn

from voice_service.app import create_app
from voice_service.config import load_settings


def main() -> None:
    settings = load_settings()
    settings.assert_loopback()
    if len(settings.token) < 16:
        raise SystemExit(
            "Set VERBO_VOICE_TOKEN before starting. "
            "pnpm voice:start writes %LOCALAPPDATA%\\Verbo\\voice-token and passes it. "
            "This process does not invent a token and does not download models."
        )
    uvicorn.run(
        create_app(settings),
        host=settings.host,
        port=settings.port,
        access_log=False,
        log_level="warning",
    )


if __name__ == "__main__":
    main()

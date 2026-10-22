from __future__ import annotations

import uvicorn

from web_service.app import create_app
from web_service.config import load_settings


def main() -> None:
    settings = load_settings()
    settings.assert_valid()
    app = create_app(settings)
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        access_log=False,
        log_level="warning",
        workers=1,
    )


if __name__ == "__main__":
    main()

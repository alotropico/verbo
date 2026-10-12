from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from voice_service.app import create_app
from voice_service.config import Settings
from voice_service.engines.fake import FakeStt, FakeTts

TOKEN = "t" * 32


def make_settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "host": "127.0.0.1",
        "port": 8765,
        "token": TOKEN,
        "engines": "fake",
        "stt_model_dir": Path("missing-stt"),
        "piper_binary": Path("missing-piper"),
        "voices_dir": Path("missing-voices"),
        "default_voice_id": "en_US-ljspeech-medium",
    }
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


@pytest.fixture
def client() -> TestClient:
    app = create_app(make_settings(), FakeStt(), FakeTts())
    return TestClient(app)


def auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}

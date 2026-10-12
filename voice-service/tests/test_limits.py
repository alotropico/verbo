import asyncio
import threading

import httpx
import pytest

from voice_service.app import create_app
from voice_service.audio import minimal_wav
from voice_service.engines.base import Readiness
from voice_service.engines.fake import FakeTts

from tests.conftest import TOKEN, make_settings


def test_second_request_is_busy() -> None:
    started = threading.Event()
    release = threading.Event()

    class BlockingStt:
        def readiness(self) -> Readiness:
            return Readiness(True, "ready")

        def transcribe(self, audio_path, cancel, language=None):  # type: ignore[no-untyped-def]
            started.set()
            release.wait(5)
            return "ok", "en"

    app = create_app(make_settings(), BlockingStt(), FakeTts())

    async def scenario() -> None:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://127.0.0.1"
        ) as http:
            files = {"audio": ("clip.wav", minimal_wav(), "audio/wav")}
            headers = {"Authorization": f"Bearer {TOKEN}"}

            async def first() -> int:
                response = await http.post(
                    "/v1/transcribe", headers=headers, files=files
                )
                return response.status_code

            pending = asyncio.create_task(first())
            became_ready = await asyncio.to_thread(started.wait, 2)
            assert became_ready
            second = await http.post("/v1/transcribe", headers=headers, files=files)
            release.set()
            assert await pending == 200
            assert second.status_code == 429

    asyncio.run(scenario())


def test_loopback_only() -> None:
    settings = make_settings(host="0.0.0.0")
    with pytest.raises(SystemExit):
        settings.assert_loopback()


def test_missing_stt_model_is_actionable(tmp_path) -> None:
    from voice_service.engines.faster_whisper import FasterWhisperEngine

    engine = FasterWhisperEngine(tmp_path / "faster-whisper-small")
    ready = engine.readiness()
    assert ready.ready is False
    assert "does not download" in ready.detail


def test_importing_stt_engine_does_not_load_weights() -> None:
    import sys

    sys.modules.pop("faster_whisper", None)
    import voice_service.engines.faster_whisper as module

    assert module.FasterWhisperEngine is not None
    assert "faster_whisper" not in sys.modules

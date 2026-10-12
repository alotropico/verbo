import os

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("VERBO_VOICE_LIVE") != "1",
    reason="Set VERBO_VOICE_LIVE=1 after local assets are installed. Launch never downloads them.",
)


def test_live_engines_stay_offline() -> None:
    os.environ["HF_HUB_OFFLINE"] = "1"
    from voice_service.config import load_settings
    from voice_service.engines.faster_whisper import FasterWhisperEngine
    from voice_service.engines.piper import piper_from_settings

    settings = load_settings()
    stt = FasterWhisperEngine(settings.stt_model_dir)
    tts = piper_from_settings(settings)
    assert stt.readiness().ready, stt.readiness().detail
    assert tts.readiness().ready, tts.readiness().detail

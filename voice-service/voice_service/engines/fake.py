from __future__ import annotations

import threading
from pathlib import Path

from voice_service.audio import minimal_wav
from voice_service.engines.base import Readiness, VoiceInfo
from voice_service.errors import RequestCancelled


class FakeStt:
    def readiness(self) -> Readiness:
        return Readiness(True, "Fake speech recognition is ready.")

    def transcribe(
        self,
        audio_path: Path,
        cancel: threading.Event,
        language: str | None = None,
    ) -> tuple[str, str]:
        if cancel.is_set():
            raise RequestCancelled()
        if not audio_path.is_file():
            raise FileNotFoundError(audio_path)
        return "voice service sample", language or "en"


class FakeTts:
    def readiness(self) -> Readiness:
        return Readiness(True, "Fake speech synthesis is ready.")

    def voices(self) -> list[VoiceInfo]:
        return [VoiceInfo(id="en_US-test", language="en_US")]

    def synthesize(
        self, text: str, voice_id: str | None, cancel: threading.Event
    ) -> bytes:
        if cancel.is_set():
            raise RequestCancelled()
        if voice_id not in {None, "en_US-test"}:
            raise ValueError("Unknown voice.")
        if not text.strip():
            raise ValueError("Empty text.")
        return minimal_wav()

from __future__ import annotations

import threading
from pathlib import Path

from voice_service.engines.base import Readiness
from voice_service.errors import EngineFailed, RequestCancelled
from voice_service.languages import ALLOWED_STT_LANGUAGES, allowed_stt_language


class FasterWhisperEngine:
    """CPU faster-whisper. The model directory must already exist; this never downloads."""

    def __init__(self, model_dir: Path) -> None:
        self._model_dir = model_dir
        self._model: object | None = None

    def readiness(self) -> Readiness:
        model_bin = self._model_dir / "model.bin"
        if not model_bin.is_file():
            return Readiness(
                False,
                "STT model is missing. Place a CTranslate2 faster-whisper model in "
                f"{self._model_dir} (expected model.bin). The service does not download it. "
                "See voice-service/README.md.",
            )
        try:
            import faster_whisper  # noqa: F401
        except ImportError:
            return Readiness(
                False,
                "faster-whisper is not installed in this Python. Install voice-service/requirements.txt.",
            )
        return Readiness(True, f"STT model directory is present at {self._model_dir}.")

    def transcribe(
        self,
        audio_path: Path,
        cancel: threading.Event,
        language: str | None = None,
    ) -> tuple[str, str]:
        if cancel.is_set():
            raise RequestCancelled()
        ready = self.readiness()
        if not ready.ready:
            raise EngineFailed(ready.detail)
        model = self._load()
        forced = language if language in ALLOWED_STT_LANGUAGES else None
        try:
            if forced is not None:
                parts, _info = _decode(model, audio_path, cancel, forced)
                return " ".join(part for part in parts if part), forced
            parts, info = _decode(model, audio_path, cancel, None)
            detected = str(getattr(info, "language", None) or "")
            language = allowed_stt_language(
                detected, getattr(info, "all_language_probs", None)
            )
            if language != detected.strip().lower():
                parts, _info = _decode(model, audio_path, cancel, language)
        except RequestCancelled:
            raise
        except Exception as error:
            raise EngineFailed("Speech recognition failed.") from error
        return " ".join(part for part in parts if part), language

    def _load(self) -> object:
        if self._model is not None:
            return self._model
        from faster_whisper import WhisperModel

        self._model = WhisperModel(
            str(self._model_dir),
            device="cpu",
            compute_type="int8",
            local_files_only=True,
        )
        return self._model


def _decode(
    model: object,
    audio_path: Path,
    cancel: threading.Event,
    language: str | None,
) -> tuple[list[str], object]:
    if cancel.is_set():
        raise RequestCancelled()
    options: dict[str, object] = {
        "vad_filter": False,
        "condition_on_previous_text": False,
    }
    if language is not None:
        options["language"] = language
    segments, info = model.transcribe(str(audio_path), **options)  # type: ignore[attr-defined]
    parts: list[str] = []
    for segment in segments:
        if cancel.is_set():
            raise RequestCancelled()
        parts.append(segment.text.strip())
    return parts, info

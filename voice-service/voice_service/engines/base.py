from __future__ import annotations

import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

VOICE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}")


@dataclass(frozen=True)
class Readiness:
    ready: bool
    detail: str


@dataclass(frozen=True)
class VoiceInfo:
    id: str
    language: str


def language_of(voice_id: str) -> str:
    head = voice_id.split("-", 1)[0]
    if re.fullmatch(r"[a-z]{2}_[A-Z]{2}", head):
        return head
    return "und"


def resolve_voice_files(voices_dir: Path, voice_id: str) -> tuple[Path, Path]:
    if not VOICE_ID.fullmatch(voice_id) or Path(voice_id).name != voice_id:
        raise ValueError("Invalid voice id.")
    root = voices_dir.resolve()
    model = (root / f"{voice_id}.onnx").resolve()
    config = (root / f"{voice_id}.onnx.json").resolve()
    if model.parent != root or config.parent != root:
        raise ValueError("Voice id escapes the voice directory.")
    if not model.is_file() or not config.is_file():
        raise FileNotFoundError(voice_id)
    return model, config


def list_installed_voices(voices_dir: Path) -> list[VoiceInfo]:
    if not voices_dir.is_dir():
        return []
    voices: list[VoiceInfo] = []
    for model in sorted(voices_dir.glob("*.onnx")):
        voice_id = model.name[: -len(".onnx")]
        config = voices_dir / f"{model.name}.json"
        if not config.is_file() or not VOICE_ID.fullmatch(voice_id):
            continue
        voices.append(VoiceInfo(id=voice_id, language=language_of(voice_id)))
    return voices


class SpeechToText(Protocol):
    def readiness(self) -> Readiness: ...

    def transcribe(
        self,
        audio_path: Path,
        cancel: threading.Event,
        language: str | None = None,
    ) -> tuple[str, str]: ...


class TextToSpeech(Protocol):
    def readiness(self) -> Readiness: ...

    def voices(self) -> list[VoiceInfo]: ...

    def synthesize(
        self, text: str, voice_id: str | None, cancel: threading.Event
    ) -> bytes: ...

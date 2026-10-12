from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
MAX_AUDIO_BYTES = 8 * 1024 * 1024
MAX_TEXT_CHARS = 2000
STT_TIMEOUT_SECONDS = 90
TTS_TIMEOUT_SECONDS = 30


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    token: str
    engines: str
    stt_model_dir: Path
    piper_binary: Path
    voices_dir: Path
    default_voice_id: str

    def assert_loopback(self) -> None:
        if self.host != DEFAULT_HOST:
            raise SystemExit(
                f"Refusing to bind {self.host}. The voice service listens on {DEFAULT_HOST} only."
            )
        if self.port < 1 or self.port > 65535:
            raise SystemExit(f"Refusing voice port {self.port}.")


def load_settings() -> Settings:
    host = os.environ.get("VERBO_VOICE_HOST", DEFAULT_HOST)
    raw_port = os.environ.get("VERBO_VOICE_PORT", str(DEFAULT_PORT))
    try:
        port = int(raw_port)
    except ValueError as error:
        raise SystemExit(f"VERBO_VOICE_PORT is not an integer: {raw_port}") from error
    engines = os.environ.get("VERBO_VOICE_ENGINES", "real")
    if engines not in {"real", "fake"}:
        raise SystemExit("VERBO_VOICE_ENGINES must be real or fake.")
    binary_name = "piper.exe" if os.name == "nt" else "piper"
    return Settings(
        host=host,
        port=port,
        token=os.environ.get("VERBO_VOICE_TOKEN", ""),
        engines=engines,
        stt_model_dir=Path(
            os.environ.get(
                "VERBO_VOICE_STT_DIR",
                ROOT / "assets" / "stt" / "faster-whisper-small",
            )
        ),
        piper_binary=Path(
            os.environ.get("VERBO_VOICE_PIPER", ROOT / "assets" / "piper" / binary_name)
        ),
        voices_dir=Path(
            os.environ.get("VERBO_VOICE_VOICES", ROOT / "assets" / "voices")
        ),
        default_voice_id=os.environ.get(
            "VERBO_VOICE_DEFAULT", "en_US-ljspeech-medium"
        ),
    )

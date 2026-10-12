from __future__ import annotations

import os
import subprocess
import tempfile
import threading
from pathlib import Path

from voice_service.audio import is_wav
from voice_service.config import Settings
from voice_service.engines.base import (
    Readiness,
    VoiceInfo,
    list_installed_voices,
    resolve_voice_files,
)
from voice_service.errors import EngineFailed, RequestCancelled


class PiperEngine:
    """Piper binary with a voice chosen from the local directory. Text is stdin, never a shell argument."""

    def __init__(
        self,
        binary: Path,
        voices_dir: Path,
        default_voice_id: str,
        argv_prefix: list[str] | None = None,
        timeout_seconds: float = 30,
    ) -> None:
        self._binary = binary
        self._voices_dir = voices_dir
        self._default_voice_id = default_voice_id
        self._argv_prefix = argv_prefix or [str(binary)]
        self._timeout_seconds = timeout_seconds

    def readiness(self) -> Readiness:
        if not self._binary.is_file() and self._argv_prefix == [str(self._binary)]:
            return Readiness(
                False,
                "Piper binary is missing at "
                f"{self._binary}. Extract rhasspy/piper 2023.11.14-2 there. "
                "The service does not download it. See voice-service/README.md.",
            )
        if not self.voices():
            return Readiness(
                False,
                "No Piper voice is installed in "
                f"{self._voices_dir}. Expected {self._default_voice_id}.onnx and "
                f"{self._default_voice_id}.onnx.json.",
            )
        return Readiness(True, f"Piper voices are present in {self._voices_dir}.")

    def voices(self) -> list[VoiceInfo]:
        return list_installed_voices(self._voices_dir)

    def synthesize(
        self, text: str, voice_id: str | None, cancel: threading.Event
    ) -> bytes:
        if cancel.is_set():
            raise RequestCancelled()
        selected = voice_id or self._select_default()
        try:
            model, _config = resolve_voice_files(self._voices_dir, selected)
        except ValueError as error:
            raise EngineFailed(str(error)) from error
        except FileNotFoundError as error:
            raise EngineFailed(f"Voice {error} is not installed.") from error
        if self._argv_prefix == [str(self._binary)] and not self._binary.is_file():
            raise EngineFailed(self.readiness().detail)
        # Windows translates newlines on Piper's stdout, which shifts 16-bit
        # samples and turns the voice into noise. A temp file stays binary.
        descriptor, raw_path = tempfile.mkstemp(prefix="verbo-voice-", suffix=".wav")
        os.close(descriptor)
        output = Path(raw_path)
        command = [
            *self._argv_prefix,
            "--model",
            str(model),
            "--output_file",
            str(output),
        ]
        cwd = (
            str(self._binary.parent)
            if self._argv_prefix == [str(self._binary)]
            else None
        )
        process: subprocess.Popen[bytes] | None = None
        try:
            process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=cwd,
                shell=False,
            )
            watcher = threading.Thread(
                target=_kill_when_cancelled, args=(process, cancel), daemon=True
            )
            watcher.start()
            process.communicate(text.encode("utf-8"), timeout=self._timeout_seconds)
            if cancel.is_set():
                raise RequestCancelled()
            if process.returncode != 0:
                raise EngineFailed("Piper exited with an error.")
            try:
                audio = output.read_bytes()
            except OSError as error:
                raise EngineFailed("Piper failed.") from error
            if not is_wav(audio):
                raise EngineFailed("Piper exited with an error.")
            return audio
        except EngineFailed:
            raise
        except subprocess.TimeoutExpired as error:
            if process is not None:
                process.kill()
                process.communicate()
            raise EngineFailed("Piper timed out.") from error
        except Exception as error:
            if process is not None:
                process.kill()
            if cancel.is_set():
                raise RequestCancelled() from error
            raise EngineFailed("Piper failed.") from error
        finally:
            output.unlink(missing_ok=True)

    def _select_default(self) -> str:
        installed = {voice.id for voice in self.voices()}
        if self._default_voice_id in installed:
            return self._default_voice_id
        if len(installed) == 1:
            return next(iter(installed))
        raise EngineFailed("Name a voiceId. No single default voice is installed.")


def _kill_when_cancelled(
    process: subprocess.Popen[bytes], cancel: threading.Event
) -> None:
    while process.poll() is None:
        if cancel.wait(0.05):
            process.kill()
            return


def piper_from_settings(settings: Settings) -> PiperEngine:
    return PiperEngine(
        binary=settings.piper_binary,
        voices_dir=settings.voices_dir,
        default_voice_id=settings.default_voice_id,
    )

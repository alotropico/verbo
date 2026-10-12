from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import secrets
import tempfile
import threading
import time
from collections.abc import Callable
from pathlib import Path

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from voice_service import API_VERSION, SERVICE_IDENTITY
from voice_service.audio import is_wav, sniff_audio
from voice_service.config import (
    MAX_AUDIO_BYTES,
    MAX_TEXT_CHARS,
    STT_TIMEOUT_SECONDS,
    TTS_TIMEOUT_SECONDS,
    Settings,
)
from voice_service.engines.base import SpeechToText, TextToSpeech
from voice_service.engines.fake import FakeStt, FakeTts
from voice_service.engines.faster_whisper import FasterWhisperEngine
from voice_service.engines.piper import piper_from_settings
from voice_service.errors import EngineFailed, RequestCancelled, VoiceError
from voice_service.languages import requested_stt_language

log = logging.getLogger("verbo.voice")


class SynthesizeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    voiceId: str | None = None


def build_engines(settings: Settings) -> tuple[SpeechToText, TextToSpeech]:
    if settings.engines == "fake":
        return FakeStt(), FakeTts()
    return FasterWhisperEngine(settings.stt_model_dir), piper_from_settings(settings)


def create_app(
    settings: Settings,
    stt: SpeechToText | None = None,
    tts: TextToSpeech | None = None,
) -> FastAPI:
    settings.assert_loopback()
    if len(settings.token) < 16:
        raise SystemExit("VERBO_VOICE_TOKEN must be at least 16 characters.")
    if stt is None and tts is None:
        stt, tts = build_engines(settings)
    elif stt is None or tts is None:
        raise SystemExit("Pass both speech engines, or neither.")
    app = FastAPI(title="Verbo voice", version=API_VERSION, docs_url=None, redoc_url=None)
    slot = asyncio.Semaphore(1)

    @app.exception_handler(VoiceError)
    async def voice_error(_request: Request, exc: VoiceError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status, content={"error": exc.code, "detail": exc.detail}
        )

    @app.exception_handler(RequestValidationError)
    async def rejected(_request: Request, _exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={"error": "invalid_request", "detail": "Request was rejected."},
        )

    @app.middleware("http")
    async def guard(request: Request, call_next: Callable) -> Response:
        started = time.perf_counter()
        if request.headers.get("origin") is not None:
            response: Response = JSONResponse(
                status_code=403,
                content={
                    "error": "origin_rejected",
                    "detail": "Browser origins cannot call the voice service.",
                },
            )
        elif not _authorized(request, settings.token):
            response = JSONResponse(
                status_code=401,
                content={
                    "error": "unauthorized",
                    "detail": "Bearer token required.",
                },
            )
        else:
            response = await call_next(request)
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        log.info(
            "%s %s %s %sms",
            request.method,
            request.url.path,
            response.status_code,
            elapsed_ms,
        )
        return response

    @app.get("/v1/health")
    async def health() -> dict[str, object]:
        stt_ready = stt.readiness()
        tts_ready = tts.readiness()
        return {
            "identity": SERVICE_IDENTITY,
            "apiVersion": API_VERSION,
            "stt": {"ready": stt_ready.ready, "detail": stt_ready.detail},
            "tts": {"ready": tts_ready.ready, "detail": tts_ready.detail},
            "voices": [
                {"id": voice.id, "language": voice.language} for voice in tts.voices()
            ],
        }

    @app.get("/v1/voices")
    async def voices() -> dict[str, object]:
        return {
            "voices": [
                {"id": voice.id, "language": voice.language} for voice in tts.voices()
            ]
        }

    @app.post("/v1/transcribe")
    async def transcribe(
        request: Request,
        audio: UploadFile | None = File(default=None),
        language: str | None = Form(default=None),
    ) -> JSONResponse:
        if audio is None:
            raise VoiceError(422, "invalid_request", "Attach an audio file.")
        try:
            chosen = requested_stt_language(language)
        except ValueError:
            raise VoiceError(422, "invalid_request", "Language must be en or es.") from None
        payload = await _read_upload(audio)
        codec = sniff_audio(payload)
        if codec is None:
            raise VoiceError(
                415,
                "unsupported_audio",
                "Audio must be wav, ogg, webm, flac, or mp3.",
            )
        await _acquire(slot)
        path: Path | None = None
        try:
            path = _write_temp(payload)

            def work(cancel: threading.Event) -> tuple[str, str]:
                return stt.transcribe(path, cancel, chosen)

            text, language = await _infer(request, work, STT_TIMEOUT_SECONDS)
        finally:
            if path is not None:
                path.unlink(missing_ok=True)
            slot.release()
        return JSONResponse({"text": text, "language": language})

    @app.post("/v1/synthesize")
    async def synthesize(request: Request, body: SynthesizeBody) -> Response:
        if "\x00" in body.text:
            raise VoiceError(422, "invalid_request", "Text contains a null character.")
        await _acquire(slot)
        try:

            def work(cancel: threading.Event) -> bytes:
                try:
                    return tts.synthesize(body.text, body.voiceId, cancel)
                except ValueError as error:
                    raise VoiceError(422, "invalid_request", "Invalid voice.") from error

            audio_bytes = await _infer(request, work, TTS_TIMEOUT_SECONDS)
        finally:
            slot.release()
        if not is_wav(audio_bytes):
            raise VoiceError(502, "bad_audio", "Synthesis did not return wav.")
        return Response(content=audio_bytes, media_type="audio/wav")

    return app


def _authorized(request: Request, token: str) -> bool:
    header = request.headers.get("authorization")
    if header is None or not header.startswith("Bearer ") or header[6] != " ":
        return False
    presented = header[7:]
    presented_b = presented.encode("utf-8")
    expected_b = token.encode("utf-8")
    if len(presented_b) != len(expected_b):
        secrets.compare_digest(expected_b, expected_b)
        return False
    return secrets.compare_digest(presented_b, expected_b)


async def _read_upload(audio: UploadFile) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        block = await audio.read(64 * 1024)
        if not block:
            break
        total += len(block)
        if total > MAX_AUDIO_BYTES:
            raise VoiceError(413, "too_large", "Audio is larger than 8 MB.")
        chunks.append(block)
    if total == 0:
        raise VoiceError(422, "invalid_request", "Audio file is empty.")
    return b"".join(chunks)


def _write_temp(payload: bytes) -> Path:
    fd, name = tempfile.mkstemp(prefix="verbo-audio-", suffix=".bin")
    try:
        os.write(fd, payload)
    finally:
        os.close(fd)
    return Path(name)


async def _acquire(slot: asyncio.Semaphore) -> None:
    try:
        await asyncio.wait_for(slot.acquire(), 0.001)
    except TimeoutError as error:
        raise VoiceError(
            429,
            "busy",
            "The voice service is already working on a request.",
        ) from error


async def _infer(
    request: Request,
    work: Callable[[threading.Event], object],
    timeout_seconds: float,
) -> object:
    cancel = threading.Event()
    task = asyncio.create_task(asyncio.to_thread(work, cancel))
    deadline = time.monotonic() + timeout_seconds
    try:
        while not task.done():
            if await request.is_disconnected():
                cancel.set()
            if time.monotonic() > deadline:
                cancel.set()
                raise VoiceError(504, "timeout", "The voice engine timed out.")
            await asyncio.wait({task}, timeout=0.2)
        try:
            result = await task
        except RequestCancelled as error:
            raise VoiceError(499, "cancelled", "Request cancelled.") from error
        except EngineFailed as error:
            raise VoiceError(500, "engine_failed", str(error)) from error
        except Exception as error:
            log.error("voice engine crashed: %s", type(error).__name__)
            raise VoiceError(500, "engine_failed", "The voice engine failed.") from error
        if cancel.is_set():
            raise VoiceError(499, "cancelled", "Request cancelled.")
        return result
    finally:
        cancel.set()
        if not task.done():
            with contextlib.suppress(Exception):
                await task

# Verbo voice service

Independent local speech API. It does not import Electron, Ollama, AGS, or the Verbo database. After the assets below are on disk, runtime does not use the network.

Verbo's Electron main process is the client inside the app. Other local programs can call the same API with the bearer token. The renderer and the model never receive that token.

## Licenses

Software and voice assets are separate. Nothing in this folder vendors a model or a Piper build.

| Piece | Pin | License |
| --- | --- | --- |
| This service | repository source | same terms as Verbo |
| faster-whisper | 1.2.1 | MIT |
| PyAV | 18.1.0 | BSD-3-Clause |
| Whisper weights (Systran CTranslate2 `faster-whisper-small`) | local directory | OpenAI Whisper weights are MIT |
| Piper binary | rhasspy/piper tag `2023.11.14-2`, asset `piper_windows_amd64.zip` | Piper source is MIT. That repository is archived. |
| espeak-ng files inside the Piper zip | bundled with that zip | GPL-3.0 |
| Default voice `en_US-ljspeech-medium` | user-supplied `.onnx` and `.onnx.json` | LJ Speech dataset is public domain. The onnx file is a derived model and is not shipped here. |

Do not substitute the current `OHF-Voice/piper1-gpl` line; that project is GPL-3.0. Lessac and Amy are not the default voice: the Blizzard 2013 Lessac license is research-only, and Amy is fine-tuned from Lessac.

## Install

Python 3.11 or newer. This workspace has been checked against the CTranslate2 3.14 Windows wheel. PyAV is pinned to 18.1.0 because faster-whisper 1.2.1 passes `metadata_errors` to `av.open`, and PyAV 19 removed that argument.

```text
cd voice-service
py -3 -m venv .venv
.venv\Scripts\python -m pip install -r requirements-dev.txt
```

Normal launch does not run pip and does not download models.

## Assets

Place files yourself:

```text
voice-service/assets/stt/faster-whisper-small/model.bin
voice-service/assets/stt/faster-whisper-small/config.json
voice-service/assets/stt/faster-whisper-small/tokenizer.json
voice-service/assets/stt/faster-whisper-small/vocabulary.txt
voice-service/assets/piper/piper.exe          (plus the DLLs and espeak-ng-data from the zip)
voice-service/assets/voices/en_US-ljspeech-medium.onnx
voice-service/assets/voices/en_US-ljspeech-medium.onnx.json
```

Suggested sources, not fetched by the service:

- STT: Hugging Face `Systran/faster-whisper-small` into `assets/stt/faster-whisper-small`.
- Piper: `https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip` extracted into `assets/piper/`.
- Voice: Hugging Face `rhasspy/piper-voices`, file `en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx` and the matching `.onnx.json`, into `assets/voices/`.

Missing files leave `/v1/health` up with `ready: false` and a path to fix. `GET /v1/health` does not load the Whisper weights.

## Run

From the repository root:

```text
pnpm voice:start
```

That writes `%LOCALAPPDATA%\Verbo\voice-token` when the file is missing, then starts `voice-service/.venv/Scripts/python.exe -m voice_service` on `http://127.0.0.1:8765` when the port is free. If a compatible service is already there, this command leaves it running and exits. `pnpm start` and the Electron app start the voice service with the app. A compatible process already on the port is adopted and stopped when the app exits. An incompatible occupant is left running. Typed chat still works when voice cannot start.

Manual start:

```text
set VERBO_VOICE_TOKEN=your-long-token
.venv\Scripts\python -m voice_service
```

The process refuses any bind host other than `127.0.0.1`.

## Other local clients

Read the token file or use `VERBO_VOICE_TOKEN`. Send `Authorization: Bearer <token>`. Do not send an `Origin` header. The example client uploads bytes and JSON text; it never sends a filesystem path for the server to open.

```text
.venv\Scripts\python examples\client.py health
.venv\Scripts\python examples\client.py transcribe sample.wav
.venv\Scripts\python examples\client.py synthesize "Hello" --out hello.wav
```

## API

All routes require the bearer token.

- `GET /v1/health` — identity `verbo-voice`, api version `1`, STT/TTS readiness, installed voices.
- `GET /v1/voices` — installed voice ids.
- `POST /v1/transcribe` — multipart field `audio` only (wav, ogg, webm, flac, or mp3, max 8 MB). No language field. The multilingual small model may come back as English or Spanish. Any other detection is decoded again as whichever of those two scored higher. Response JSON `{ "text", "language" }` is `en` or `es`. Silero VAD stays off so the first transcription does not download a VAD model.
- `POST /v1/synthesize` — JSON `{ "text", "voiceId"? }` (max 2000 characters). Response `audio/wav`. Extra JSON fields are rejected and not echoed.

One transcribe or synthesize runs at a time. Another gets HTTP 429. Disconnect or the Verbo client's cancel kills Piper. faster-whisper stops between segments; a native decode already in progress can finish before the slot frees. Logs record method, path, status, and milliseconds. They do not record transcript text, synthesis text, or the token.

## Tests

Vitest does not cover this package.

```text
pnpm voice:test
```

`VERBO_VOICE_LIVE=1` enables `tests/test_live.py`, which checks that installed assets are readable with Hugging Face hub offline. It still does not download them.

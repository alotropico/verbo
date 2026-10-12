"""Example client for the local voice service. Uploads bytes and text; never a server path."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Call the local Verbo voice service.")
    parser.add_argument("--base-url", default=os.environ.get("VERBO_VOICE_BASE_URL", "http://127.0.0.1:8765"))
    parser.add_argument("--token-file", default=default_token_file())
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("health")
    sub.add_parser("voices")
    transcribe = sub.add_parser("transcribe")
    transcribe.add_argument("file", type=Path)
    synthesize = sub.add_parser("synthesize")
    synthesize.add_argument("text")
    synthesize.add_argument("--out", type=Path, required=True)
    synthesize.add_argument("--voice")
    args = parser.parse_args()
    token = os.environ.get("VERBO_VOICE_TOKEN") or read_token(Path(args.token_file))
    base = args.base_url.rstrip("/")
    if args.command == "health":
        print(request_json("GET", f"{base}/v1/health", token))
        return
    if args.command == "voices":
        print(request_json("GET", f"{base}/v1/voices", token))
        return
    if args.command == "transcribe":
        print(post_audio(f"{base}/v1/transcribe", token, args.file))
        return
    audio = post_json(
        f"{base}/v1/synthesize",
        token,
        {"text": args.text, **({"voiceId": args.voice} if args.voice else {})},
    )
    args.out.write_bytes(audio)
    print(args.out)


def default_token_file() -> str:
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        local = str(Path.home() / "AppData" / "Local")
    return str(Path(local) / "Verbo" / "voice-token")


def read_token(path: Path) -> str:
    token = path.read_text(encoding="utf-8").strip()
    if len(token) < 16:
        raise SystemExit(f"Token file is unusable: {path}")
    return token


def request_json(method: str, url: str, token: str) -> str:
    request = urllib.request.Request(url, method=method, headers=headers(token))
    with urllib.request.urlopen(request, timeout=10) as response:
        return response.read().decode("utf-8")


def post_json(url: str, token: str, payload: dict[str, str]) -> bytes:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={**headers(token), "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        raise SystemExit(error.read().decode("utf-8", errors="replace")) from error


def post_audio(url: str, token: str, path: Path) -> str:
    content, content_type = multipart(path.read_bytes())
    request = urllib.request.Request(
        url,
        data=content,
        method="POST",
        headers={**headers(token), "Content-Type": content_type},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        raise SystemExit(error.read().decode("utf-8", errors="replace")) from error


def headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def multipart(audio: bytes) -> tuple[bytes, str]:
    boundary = f"----verbo{uuid.uuid4().hex}"
    head = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="audio"; filename="audio.bin"\r\n'
        "Content-Type: application/octet-stream\r\n\r\n"
    ).encode("utf-8")
    tail = f"\r\n--{boundary}--\r\n".encode("utf-8")
    return head + audio + tail, f"multipart/form-data; boundary={boundary}"


if __name__ == "__main__":
    try:
        main()
    except urllib.error.URLError as error:
        print(error, file=sys.stderr)
        raise SystemExit(1) from error

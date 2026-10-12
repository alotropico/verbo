from __future__ import annotations

import struct


def minimal_wav() -> bytes:
    sample_rate = 8000
    frame_count = 800
    data = b"\x00\x00" * frame_count
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + len(data),
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        sample_rate,
        sample_rate * 2,
        2,
        16,
        b"data",
        len(data),
    )
    return header + data


def sniff_audio(data: bytes) -> str | None:
    if len(data) < 12:
        return None
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "wav"
    if data[:4] == b"OggS":
        return "ogg"
    if data[:4] == b"\x1aE\xdf\xa3":
        return "webm"
    if data[:4] == b"fLaC":
        return "flac"
    if data[:3] == b"ID3":
        return "mp3"
    if data[0] == 0xFF and (data[1] & 0xE0) == 0xE0:
        return "mp3"
    return None


def is_wav(data: bytes) -> bool:
    return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE"

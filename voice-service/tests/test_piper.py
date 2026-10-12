import sys
import threading
from pathlib import Path

import pytest

from voice_service.audio import minimal_wav
from voice_service.engines.piper import PiperEngine
from voice_service.errors import EngineFailed, RequestCancelled


def test_reads_wav_from_the_output_file(tmp_path: Path) -> None:
    wav = minimal_wav()
    script = tmp_path / "write_wav.py"
    script.write_text(
        "import sys\n"
        "from pathlib import Path\n"
        "out = sys.argv[sys.argv.index('--output_file') + 1]\n"
        f"Path(out).write_bytes({wav!r})\n"
        "sys.stdout.buffer.write(b'RIFF' + b'\\r\\n' * 40)\n"
        "sys.stdin.read()\n",
        encoding="utf-8",
    )
    voices = tmp_path / "voices"
    voices.mkdir()
    (voices / "en_US-test.onnx").write_bytes(b"x")
    (voices / "en_US-test.onnx.json").write_text("{}", encoding="utf-8")
    engine = PiperEngine(
        binary=Path(sys.executable),
        voices_dir=voices,
        default_voice_id="en_US-test",
        argv_prefix=[sys.executable, str(script)],
    )
    assert engine.synthesize("hello", None, threading.Event()) == wav


def test_missing_binary_is_an_engine_error(tmp_path: Path) -> None:
    voices = tmp_path / "voices"
    voices.mkdir()
    (voices / "en_US-test.onnx").write_bytes(b"x")
    (voices / "en_US-test.onnx.json").write_text("{}", encoding="utf-8")
    engine = PiperEngine(
        binary=tmp_path / "missing-piper.exe",
        voices_dir=voices,
        default_voice_id="en_US-test",
    )
    with pytest.raises(EngineFailed, match="Piper binary is missing"):
        engine.synthesize("hello", None, threading.Event())


def test_voice_id_cannot_escape(tmp_path: Path) -> None:
    marker = tmp_path / "started"
    script = tmp_path / "slow.py"
    script.write_text(
        "from pathlib import Path\n"
        f"Path({str(marker)!r}).write_text('yes')\n",
        encoding="utf-8",
    )
    voices = tmp_path / "voices"
    voices.mkdir()
    engine = PiperEngine(
        binary=Path(sys.executable),
        voices_dir=voices,
        default_voice_id="en_US-ljspeech-medium",
        argv_prefix=[sys.executable, str(script)],
        timeout_seconds=2,
    )
    with pytest.raises(EngineFailed):
        engine.synthesize("hello", "../secret", threading.Event())
    assert not marker.exists()


def test_cancel_kills_piper_process(tmp_path: Path) -> None:
    marker = tmp_path / "started"
    script = tmp_path / "slow.py"
    script.write_text(
        "import sys, time\n"
        "from pathlib import Path\n"
        f"Path({str(marker)!r}).write_text('yes')\n"
        "sys.stdin.read()\n"
        "time.sleep(30)\n",
        encoding="utf-8",
    )
    voices = tmp_path / "voices"
    voices.mkdir()
    model = voices / "en_US-ljspeech-medium.onnx"
    config = voices / "en_US-ljspeech-medium.onnx.json"
    model.write_bytes(b"not-a-real-model")
    config.write_text("{}", encoding="utf-8")
    engine = PiperEngine(
        binary=Path(sys.executable),
        voices_dir=voices,
        default_voice_id="en_US-ljspeech-medium",
        argv_prefix=[sys.executable, str(script)],
        timeout_seconds=5,
    )
    cancel = threading.Event()
    caught: list[BaseException] = []

    def run() -> None:
        try:
            engine.synthesize("hello", None, cancel)
        except BaseException as error:  # noqa: BLE001 - the test records the engine error
            caught.append(error)

    worker = threading.Thread(target=run)
    worker.start()
    for _ in range(40):
        if marker.exists():
            break
        threading.Event().wait(0.05)
    cancel.set()
    worker.join(3)
    assert not worker.is_alive()
    assert caught and isinstance(caught[0], RequestCancelled)

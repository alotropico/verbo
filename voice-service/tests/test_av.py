import os
import tempfile

import av

from voice_service.audio import minimal_wav


def test_pyav_still_accepts_metadata_errors() -> None:
    fd, name = tempfile.mkstemp(suffix=".wav")
    os.write(fd, minimal_wav())
    os.close(fd)
    try:
        with av.open(name, mode="r", metadata_errors="ignore") as container:
            assert len(container.streams.audio) == 1
    finally:
        os.remove(name)

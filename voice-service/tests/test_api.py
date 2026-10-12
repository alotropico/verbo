from voice_service.audio import minimal_wav
from voice_service.config import MAX_AUDIO_BYTES

from tests.conftest import TOKEN, auth


def test_health_requires_token(client) -> None:
    denied = client.get("/v1/health")
    assert denied.status_code == 401
    ok = client.get("/v1/health", headers=auth())
    assert ok.status_code == 200
    body = ok.json()
    assert body["identity"] == "verbo-voice"
    assert body["apiVersion"] == "1"
    assert body["stt"]["ready"] is True
    assert body["voices"][0]["id"] == "en_US-test"


def test_wrong_token_is_unauthorized(client) -> None:
    response = client.get("/v1/health", headers={"Authorization": "Bearer nope"})
    assert response.status_code == 401


def test_browser_origin_is_rejected(client) -> None:
    response = client.get(
        "/v1/health",
        headers={**auth(), "Origin": "http://evil.example"},
    )
    assert response.status_code == 403


def test_transcribe_and_synthesize(client) -> None:
    heard = client.post(
        "/v1/transcribe",
        headers=auth(),
        files={"audio": ("clip.wav", minimal_wav(), "audio/wav")},
    )
    assert heard.status_code == 200
    assert heard.json()["text"] == "voice service sample"
    spoken = client.post(
        "/v1/synthesize",
        headers=auth(),
        json={"text": "Hello", "voiceId": "en_US-test"},
    )
    assert spoken.status_code == 200
    assert spoken.headers["content-type"].startswith("audio/wav")
    assert spoken.content[:4] == b"RIFF"


def test_rejects_extra_path_field_without_echoing_it(client) -> None:
    secret = r"C:\Windows\System32\config\SAM"
    response = client.post(
        "/v1/synthesize",
        headers=auth(),
        json={"text": "Hello", "path": secret},
    )
    assert response.status_code == 422
    assert secret not in response.text
    assert "Hello" not in response.text


def test_transcribe_language_is_english_or_spanish(client) -> None:
    rejected = client.post(
        "/v1/transcribe",
        headers=auth(),
        data={"language": "fr"},
        files={"audio": ("clip.wav", minimal_wav(), "audio/wav")},
    )
    assert rejected.status_code == 422
    forced = client.post(
        "/v1/transcribe",
        headers=auth(),
        data={"language": "es"},
        files={"audio": ("clip.wav", minimal_wav(), "audio/wav")},
    )
    assert forced.status_code == 200
    assert forced.json()["language"] == "es"


def test_rejects_text_that_is_not_audio(client) -> None:
    response = client.post(
        "/v1/transcribe",
        headers=auth(),
        files={"audio": ("notes.txt", b"this is not audio", "text/plain")},
    )
    assert response.status_code == 415


def test_rejects_oversize_audio(client) -> None:
    payload = b"RIFF" + b"\x00" * (MAX_AUDIO_BYTES + 8)
    response = client.post(
        "/v1/transcribe",
        headers=auth(),
        files={"audio": ("big.wav", payload, "audio/wav")},
    )
    assert response.status_code == 413


def test_upload_filename_is_not_a_path(client, tmp_path) -> None:
    target = tmp_path / "pwned.wav"
    response = client.post(
        "/v1/transcribe",
        headers=auth(),
        files={"audio": (str(target), minimal_wav(), "audio/wav")},
    )
    assert response.status_code == 200
    assert not target.exists()


def test_synthesis_text_is_not_logged(client, caplog) -> None:
    caplog.set_level("INFO", logger="verbo.voice")
    phrase = "secret phrase please"
    response = client.post(
        "/v1/synthesize",
        headers=auth(),
        json={"text": phrase},
    )
    assert response.status_code == 200
    assert phrase not in caplog.text
    assert TOKEN not in caplog.text

import pytest

from voice_service.languages import allowed_stt_language, requested_stt_language


def test_keeps_english_and_spanish() -> None:
    assert allowed_stt_language("en", [("fr", 0.9)]) == "en"
    assert allowed_stt_language("es", [("en", 0.4)]) == "es"


def test_replaces_french_or_chinese_with_the_stronger_allowed_language() -> None:
    assert (
        allowed_stt_language("fr", [("fr", 0.62), ("es", 0.21), ("en", 0.09)])
        == "es"
    )
    assert (
        allowed_stt_language("zh", [("zh", 0.7), ("en", 0.18), ("es", 0.04)])
        == "en"
    )
    assert allowed_stt_language("zh", None) == "en"


def test_requested_language_is_english_spanish_or_detect() -> None:
    assert requested_stt_language(None) is None
    assert requested_stt_language("  ") is None
    assert requested_stt_language("EN") == "en"
    assert requested_stt_language("es") == "es"
    with pytest.raises(ValueError):
        requested_stt_language("fr")

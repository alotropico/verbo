ALLOWED_STT_LANGUAGES = frozenset({"en", "es"})


def requested_stt_language(value: str | None) -> str | None:
    """None keeps detection inside English and Spanish. en or es forces that language."""
    if value is None or value.strip() == "":
        return None
    code = value.strip().lower()
    if code not in ALLOWED_STT_LANGUAGES:
        raise ValueError(code)
    return code


def allowed_stt_language(
    detected: str | None,
    probabilities: list[tuple[str, float]] | None,
) -> str:
    """Keep English or Spanish. A different detection falls back to the stronger of those two."""
    code = (detected or "").strip().lower()
    if code in ALLOWED_STT_LANGUAGES:
        return code
    best = "en"
    best_score = float("-inf")
    for language, score in probabilities or []:
        normalized = language.strip().lower()
        if normalized not in ALLOWED_STT_LANGUAGES or score <= best_score:
            continue
        best = normalized
        best_score = score
    return best

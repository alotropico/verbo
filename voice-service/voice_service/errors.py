class VoiceError(Exception):
    def __init__(self, status: int, code: str, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.code = code
        self.detail = detail


class RequestCancelled(Exception):
    pass


class EngineFailed(Exception):
    pass

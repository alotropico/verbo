# Verbo Web Search Service

Isolated native Windows web search service for Verbo, powered by pinned official SearXNG execution inside a minimal FastAPI host.

## Overview

- **Port / Host**: `127.0.0.1:8766` only (refuses non-loopback bindings).
- **Supported Python**: Python 3.14 (64-bit on Windows).
- **Pinned SearXNG revision**: `81371861f67226091d1c4df2e3908a11d3b54eb9` (official `searxng/searxng` repository).
- **Engines supported**: `duckduckgo`, `brave`, `bing`, `google`, `wikipedia`, `github`.
- **Categories**: `general`, `it`, `science`, `news`. Note that category support is constrained to what these 6 engines declare; when querying `it`, only `github` supports it, while `science` and `news` are skipped with `unsupported_category`.
- **Token ownership**: The Verbo supervisor writes `%LOCALAPPDATA%/Verbo/web-token` (or `~/.verbo/web-token`) and passes `VERBO_WEB_TOKEN`. The Python service never invents a competing token.
- **Database / Cache isolation**: Runtime configuration and SearXNG caches reside exclusively in `web-service/.runtime/`, separate from Verbo's database.
- **Packaging scope**: Local venv files and Python binaries are excluded from packaged Electron builds (`electron-builder.yml`). Missing local dependencies report an ordinary offline state.

## License & Upstream Notices

SearXNG is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-or-later).
This service interacts with SearXNG solely via internal imported module execution in an isolated helper process.

## Setup & Running

### 1. Dedicated Virtual Environment

```powershell
python -m venv web-service\.venv
.\web-service\.venv\Scripts\python.exe -m pip install -r web-service\requirements-bootstrap.txt
.\web-service\.venv\Scripts\python.exe -m pip install --no-build-isolation -r web-service\requirements-dev.txt
```

### 2. Standalone Start

```powershell
$env:VERBO_WEB_HOST = "127.0.0.1"
$env:VERBO_WEB_PORT = "8766"
$env:VERBO_WEB_TOKEN = "test-token-at-least-16-characters-long"
.\web-service\.venv\Scripts\python.exe -m web_service
```

Or from the repository root:
```powershell
pnpm web:start
```

### 3. Running Isolated Tests

```powershell
pnpm web:test
```

Or with live network opt-in:
```powershell
$env:VERBO_WEB_LIVE = "1"
pnpm web:test
```

## API Endpoints

All endpoints require a matching `Authorization: Bearer <token>` header and reject requests containing an `Origin` header.

### `GET /v1/health`
Returns service readiness and available engines.
```json
{
  "identity": "verbo-web",
  "apiVersion": "1",
  "ready": true,
  "engines": ["duckduckgo", "brave", "bing", "google", "wikipedia", "github"]
}
```

### `POST /v1/search`
Searches using the requested engines.
Payload:
```json
{
  "query": "search terms",
  "engines": ["duckduckgo", "brave", "bing"],
  "category": "general",
  "pageno": 1,
  "timeoutMs": 8000
}
```
Response:
```json
{
  "results": [
    {
      "title": "Page Title",
      "url": "https://example.com",
      "snippet": "Snippet content...",
      "engine": "duckduckgo"
    }
  ],
  "unresponsiveEngines": []
}
```

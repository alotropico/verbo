import {
  DEFAULT_WEB_BASE_URL,
  parseWebBaseUrl,
  WEB_API_VERSION,
  WEB_IDENTITY,
  type EngineFailure,
  type EngineId,
  type NextInput,
  type SearchInput,
  type WebFailure,
  type WebSearchResult,
  type WebStatus,
} from "../../shared/web";
import { type DefaultWebSettings, type WebSettings } from "../../shared/web-settings";
import { normalizeOrganicResults } from "./normalize";
import { SessionStore } from "./session-store";
import { loadWebSettings } from "./settings-store";
import { readWebToken } from "./token-path";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MiB

export type WebClientOptions = {
  baseUrl?: string;
  token?: string;
  readToken?: () => string | null;
  getSettings: () => WebSettings | DefaultWebSettings;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
  uuid?: () => string;
};

export type WebClient = {
  status: (signal?: AbortSignal) => Promise<WebStatus>;
  search: (input: SearchInput) => Promise<WebSearchResult>;
  next: (input: NextInput) => Promise<WebSearchResult>;
  dispose: () => void;
};

function isNetworkDown(error: unknown): boolean {
  if (error && typeof error === "object") {
    const err = error as Record<string, unknown>;
    const cause = err.cause as Record<string, unknown> | undefined;
    const code = cause?.code ?? err.code;
    return (
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "UND_ERR_CONNECT_TIMEOUT" ||
      err.name === "TimeoutError" ||
      error instanceof TypeError
    );
  }
  return false;
}

async function readBoundedText(response: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error("response_too_large");
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export function createWebClient(options: WebClientOptions): WebClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = parseWebBaseUrl(options.baseUrl ?? process.env.VERBO_WEB_BASE_URL ?? DEFAULT_WEB_BASE_URL);
  const now = options.now ?? Date.now;
  const uuid = options.uuid;
  const sessionStore = new SessionStore();

  function getToken(): string | null {
    if (options.token) return options.token;
    if (options.readToken) return options.readToken();
    return null;
  }

  async function status(signal?: AbortSignal): Promise<WebStatus> {
    const token = getToken();
    if (!token) {
      return {
        ok: false,
        code: "unauthorized",
        detail: "Web token is not available.",
      };
    }

    try {
      const response = await fetchImpl(`${baseUrl}/v1/health`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: signal ?? AbortSignal.timeout(2000),
      });

      if (response.status === 401) {
        return {
          ok: false,
          code: "unauthorized",
          detail: "Web service rejected authorization token.",
        };
      }
      if (response.status === 403) {
        return {
          ok: false,
          code: "unauthorized",
          detail: "Web service rejected request origin.",
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          code: "incompatible",
          detail: `Web service returned HTTP ${response.status}.`,
        };
      }

      const body = (await response.json()) as Record<string, unknown>;
      if (
        body?.identity === WEB_IDENTITY &&
        body?.apiVersion === WEB_API_VERSION &&
        typeof body?.ready === "boolean" &&
        Array.isArray(body?.engines)
      ) {
        return {
          ok: true,
          identity: WEB_IDENTITY,
          apiVersion: WEB_API_VERSION,
          ready: body.ready,
          engines: body.engines as EngineId[],
          detail: typeof body.detail === "string" ? body.detail : undefined,
        };
      }

      return {
        ok: false,
        code: "incompatible",
        detail: "Web service returned incompatible identity or version.",
      };
    } catch (error) {
      if (isNetworkDown(error)) {
        return {
          ok: false,
          code: "offline",
          detail: "Web search service is offline.",
        };
      }
      return {
        ok: false,
        code: "bad_response",
        detail: error instanceof Error ? error.message : "Failed to query web service.",
      };
    }
  }

  async function search(input: SearchInput): Promise<WebSearchResult> {
    if (input.signal?.aborted) {
      return {
        ok: false,
        code: "cancelled",
        detail: "Search request was cancelled.",
      };
    }

    const trimmedQuery = input.query ? input.query.trim() : "";
    if (!trimmedQuery || trimmedQuery.length > 2048) {
      return {
        ok: false,
        code: "invalid_request",
        detail: "Query must be between 1 and 2048 non-whitespace characters.",
      };
    }

    const token = getToken();
    if (!token) {
      return {
        ok: false,
        code: "unauthorized",
        detail: "Web service token is not available.",
      };
    }

    const settings = options.getSettings();
    const effectivePageSize = input.pageSize ?? settings.pageSize;
    if (!Number.isInteger(effectivePageSize) || effectivePageSize < 1 || effectivePageSize > 10) {
      return {
        ok: false,
        code: "invalid_request",
        detail: "Page size must be an integer between 1 and 10.",
      };
    }

    const category = input.category ?? "general";
    const timeoutMs = settings.timeoutMs;
    const httpDeadlineMs = timeoutMs + 1000;

    const payload = {
      query: trimmedQuery,
      engines: [...settings.engines],
      category,
      pageno: 1,
      timeoutMs,
    };

    // Combine caller signal with HTTP timeout deadline
    const timeoutSignal = AbortSignal.timeout(httpDeadlineMs);
    const combinedSignal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;

    const interruption = (error?: unknown): WebFailure | null => {
      if (input.signal?.aborted) {
        return { ok: false, code: "cancelled", detail: "Search request was cancelled." };
      }
      if (timeoutSignal.aborted || (error instanceof Error && error.name === "TimeoutError")) {
        return { ok: false, code: "timeout", detail: "Search request timed out." };
      }
      return null;
    };

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/v1/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: combinedSignal,
      });
    } catch (error: unknown) {
      const interrupted = interruption(error);
      if (interrupted) return interrupted;
      if (isNetworkDown(error)) {
        return {
          ok: false,
          code: "offline",
          detail: "Web search service is offline.",
        };
      }
      return {
        ok: false,
        code: "bad_response",
        detail: error instanceof Error ? error.message : "Search request failed.",
      };
    }

    if (!response.ok) {
      let errorDetail = `Search service returned HTTP ${response.status}.`;
      let errorCode: WebFailure["code"] = "bad_response";
      try {
        const errJson = JSON.parse(await readBoundedText(response)) as Record<string, unknown>;
        if (typeof errJson?.detail === "string") errorDetail = errJson.detail;
        if (errJson?.error === "upstream_error") errorCode = "upstream_error";
        else if (errJson?.error === "busy") errorCode = "busy";
        else if (errJson?.error === "not_ready") errorCode = "not_ready";
        else if (errJson?.error === "invalid_request") errorCode = "invalid_request";
      } catch (error) {
        const interrupted = interruption(error);
        if (interrupted) return interrupted;
        // The status line is enough if the error body is invalid.
      }

      const interrupted = interruption();
      if (interrupted) return interrupted;

      if (response.status === 401) errorCode = "unauthorized";
      else if (response.status === 403) errorCode = "unauthorized";
      else if (response.status === 422) errorCode = "invalid_request";
      else if (response.status === 429) errorCode = "busy";
      else if (response.status === 504) errorCode = "timeout";
      else if (response.status === 503 && errorCode !== "upstream_error") {
        errorCode = "not_ready";
      }

      return {
        ok: false,
        code: errorCode,
        detail: errorDetail,
      };
    }

    let rawText: string;
    try {
      rawText = await readBoundedText(response, MAX_RESPONSE_BYTES);
    } catch (error: unknown) {
      const interrupted = interruption(error);
      if (interrupted) return interrupted;
      if (error instanceof Error && error.message === "response_too_large") {
        return {
          ok: false,
          code: "bad_response",
          detail: "Search response exceeded 2 MiB limit.",
        };
      }
      return {
        ok: false,
        code: "bad_response",
        detail: "Failed to read search response body.",
      };
    }

    const interrupted = interruption();
    if (interrupted) return interrupted;

    let parsedBody: Record<string, unknown> | null = null;
    try {
      parsedBody = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        code: "bad_response",
        detail: "Malformed JSON response envelope.",
      };
    }

    if (
      !parsedBody ||
      typeof parsedBody !== "object" ||
      !Array.isArray(parsedBody.results) ||
      !Array.isArray(parsedBody.unresponsiveEngines)
    ) {
      return {
        ok: false,
        code: "bad_response",
        detail: "Malformed search response envelope structure.",
      };
    }

    const normalizedResults = normalizeOrganicResults(parsedBody.results, settings.maxSnippetChars);

    const unresponsiveEngines: EngineFailure[] = [];
    for (const item of parsedBody.unresponsiveEngines as unknown[]) {
      if (
        item &&
        typeof item === "object" &&
        "engine" in item &&
        typeof item.engine === "string" &&
        "error" in item &&
        typeof item.error === "string"
      ) {
        unresponsiveEngines.push({
          engine: item.engine as EngineId,
          error: item.error.slice(0, 200),
        });
      }
    }

    return sessionStore.createSession(
      {
        query: trimmedQuery,
        results: normalizedResults,
        enginesUsed: [...settings.engines],
        unresponsiveEngines,
        pageSize: effectivePageSize,
      },
      now(),
      uuid,
    );
  }

  async function next(input: NextInput): Promise<WebSearchResult> {
    return sessionStore.next(input.cursor, input.pageSize, input.signal, now(), uuid);
  }

  function dispose(): void {
    sessionStore.dispose();
  }

  return {
    status,
    search,
    next,
    dispose,
  };
}

let lazyClient: WebClient | null = null;

export function webClient(): WebClient {
  if (!lazyClient) {
    lazyClient = createWebClient({
      getSettings: loadWebSettings,
      readToken: readWebToken,
    });
  }
  return lazyClient;
}

export function resetWebClient(): void {
  if (lazyClient) {
    lazyClient.dispose();
    lazyClient = null;
  }
}

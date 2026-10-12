import { Buffer } from "node:buffer";
import {
  DEFAULT_VOICE_BASE_URL,
  parseVoiceBaseUrl,
  VOICE_API_VERSION,
  VOICE_IDENTITY,
  type VoiceAudioResult,
  type VoiceFailure,
  type VoiceStatus,
  type VoiceSynthInput,
  type VoiceTextResult,
} from "../../shared/voice";
import { readVoiceToken } from "./token-path";

type FetchLike = typeof fetch;

export type VoiceTranscribeOptions = {
  signal?: AbortSignal;
  language?: "en" | "es";
};

export type VoiceClient = {
  status: () => Promise<VoiceStatus>;
  transcribe: (
    audio: Uint8Array,
    options?: VoiceTranscribeOptions,
  ) => Promise<VoiceTextResult>;
  synthesize: (
    input: VoiceSynthInput,
    signal?: AbortSignal,
  ) => Promise<VoiceAudioResult>;
};

export type VoiceBridge = VoiceClient & {
  cancel: () => void;
};

const healthSchema = {
  identity: VOICE_IDENTITY,
  apiVersion: VOICE_API_VERSION,
} as const;

export function createVoiceClient(options: {
  baseUrl: string;
  token?: string | null;
  readToken?: () => string | null;
  fetchImpl?: FetchLike;
}): VoiceClient {
  let origin: string;
  try {
    origin = parseVoiceBaseUrl(options.baseUrl);
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.message
        : "Voice URL is invalid. Typed chat still works.";
    return deadClient(detail);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const tokenFor = (): string | null =>
    options.readToken ? options.readToken() : (options.token ?? null);

  const status = async (): Promise<VoiceStatus> => {
    const token = tokenFor();
    if (!token) {
      return {
        ok: false,
        code: "offline",
        detail:
          "Voice token is missing. Typed chat still works. Start with pnpm start or pnpm voice:start.",
      };
    }
    try {
      const response = await fetchImpl(`${origin}/v1/health`, {
        headers: auth(token),
        signal: AbortSignal.timeout(2500),
      });
      if (response.status === 401) {
        return {
          ok: false,
          code: "unauthorized",
          detail:
            "Voice service rejected the token. Typed chat still works. The running process was left alone.",
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          code: "offline",
          detail: "Voice service is offline. Typed chat still works.",
        };
      }
      const body = (await response.json()) as {
        identity?: string;
        apiVersion?: string;
        stt?: { ready?: boolean; detail?: string };
        tts?: { ready?: boolean; detail?: string };
        voices?: { id?: string; language?: string }[];
      };
      if (
        body.identity !== healthSchema.identity ||
        body.apiVersion !== healthSchema.apiVersion
      ) {
        return {
          ok: false,
          code: "incompatible",
          detail:
            "The process on the voice port is not this Verbo voice service. Typed chat still works.",
        };
      }
      return {
        ok: true,
        identity: VOICE_IDENTITY,
        apiVersion: VOICE_API_VERSION,
        stt: {
          ready: body.stt?.ready === true,
          detail: body.stt?.detail ?? "",
        },
        tts: {
          ready: body.tts?.ready === true,
          detail: body.tts?.detail ?? "",
        },
        voices: (body.voices ?? [])
          .filter((voice) => voice.id && voice.language)
          .map((voice) => ({
            id: voice.id as string,
            language: voice.language as string,
          })),
      };
    } catch {
      return {
        ok: false,
        code: "offline",
        detail: "Voice service is offline. Typed chat still works.",
      };
    }
  };

  return {
    status,
    async transcribe(audio, options) {
      return post(
        fetchImpl,
        origin,
        tokenFor(),
        options?.signal,
        "/v1/transcribe",
        {
          body: multipart(audio, options?.language),
          headers: multipartHeaders(),
          parse: async (response) => {
            const json = (await response.json()) as {
              text?: string;
              language?: string;
            };
            if (typeof json.text !== "string") {
              return {
                ok: false,
                code: "bad_response",
                detail: "Transcription response was incomplete.",
              };
            }
            return {
              ok: true,
              text: json.text,
              language: json.language ?? "und",
            };
          },
        },
      );
    },
    async synthesize(input, signal) {
      return post(fetchImpl, origin, tokenFor(), signal, "/v1/synthesize", {
        body: JSON.stringify({
          text: input.text,
          ...(input.voiceId ? { voiceId: input.voiceId } : {}),
        }),
        headers: { "Content-Type": "application/json" },
        parse: async (response) => {
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength < 12 || bytes[0] !== 0x52) {
            return {
              ok: false,
              code: "bad_response",
              detail: "Synthesis did not return wav.",
            };
          }
          return { ok: true, audio: bytes };
        },
      });
    },
  };
}

export function createVoiceBridge(client: VoiceClient): VoiceBridge {
  let transcribeController: AbortController | null = null;
  let synthesizeController: AbortController | null = null;
  const signal = (kind: "transcribe" | "synthesize"): AbortSignal => {
    const previous =
      kind === "transcribe" ? transcribeController : synthesizeController;
    previous?.abort();
    const next = new AbortController();
    if (kind === "transcribe") transcribeController = next;
    else synthesizeController = next;
    return next.signal;
  };
  return {
    cancel(): void {
      transcribeController?.abort();
      synthesizeController?.abort();
    },
    status: () => client.status(),
    transcribe: (audio, options) =>
      client.transcribe(audio, {
        ...options,
        signal: signal("transcribe"),
      }),
    synthesize: (input) => client.synthesize(input, signal("synthesize")),
  };
}

let bridge: VoiceBridge | null = null;

export function voiceBridge(): VoiceBridge {
  bridge ??= createVoiceBridge(
    createVoiceClient({
      baseUrl: process.env.VERBO_VOICE_BASE_URL ?? DEFAULT_VOICE_BASE_URL,
      readToken: readVoiceToken,
    }),
  );
  return bridge;
}

function deadClient(detail: string): VoiceClient {
  const failure: VoiceFailure = { ok: false, code: "offline", detail };
  const offline: VoiceStatus = { ok: false, code: "offline", detail };
  return {
    status: () => Promise.resolve(offline),
    transcribe: () => Promise.resolve(failure),
    synthesize: () => Promise.resolve(failure),
  };
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function multipart(audio: Uint8Array, language?: "en" | "es"): Uint8Array {
  const boundary = "----verbo-voice";
  const languagePart =
    language === undefined
      ? new Uint8Array()
      : new TextEncoder().encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n`,
        );
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="audio.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(
    languagePart.length + head.length + audio.length + tail.length,
  );
  body.set(languagePart, 0);
  body.set(head, languagePart.length);
  body.set(audio, languagePart.length + head.length);
  body.set(tail, languagePart.length + head.length + audio.length);
  return body;
}

function multipartHeaders(): Record<string, string> {
  return { "Content-Type": "multipart/form-data; boundary=----verbo-voice" };
}

async function post<
  T extends { ok: true } | { ok: false; code: string; detail: string },
>(
  fetchImpl: FetchLike,
  origin: string,
  token: string | null,
  signal: AbortSignal | undefined,
  path: string,
  request: {
    body: string | Uint8Array;
    headers: Record<string, string>;
    parse: (response: Response) => Promise<T>;
  },
): Promise<T | { ok: false; code: string; detail: string }> {
  if (!token) {
    return {
      ok: false,
      code: "offline",
      detail:
        "Voice token is missing. Typed chat still works. Start with pnpm start or pnpm voice:start.",
    };
  }
  try {
    const response = await fetchImpl(`${origin}${path}`, {
      method: "POST",
      headers: { ...auth(token), ...request.headers },
      body:
        typeof request.body === "string"
          ? request.body
          : Buffer.from(request.body),
      signal,
    });
    if (!response.ok) return failureFrom(response);
    return await request.parse(response);
  } catch (error) {
    if (isAbort(error)) {
      return {
        ok: false,
        code: "cancelled",
        detail: "Voice request cancelled.",
      };
    }
    return {
      ok: false,
      code: "offline",
      detail: "Voice service is offline. Typed chat still works.",
    };
  }
}

async function failureFrom(
  response: Response,
): Promise<{ ok: false; code: string; detail: string }> {
  let code = "voice_error";
  let detail = `Voice service returned HTTP ${response.status}.`;
  try {
    const body = (await response.json()) as { error?: string; detail?: string };
    if (body.error) code = body.error;
    if (body.detail) detail = body.detail.slice(0, 300);
  } catch {
    // The status line is enough when the body is not JSON.
  }
  return { ok: false, code, detail };
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

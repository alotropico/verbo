import { OLLAMA_BASE_URL } from "../../shared/config";

export type OllamaProbe = { state: "ready"; version: string } | { state: "absent" } | { state: "unresponsive"; detail: string };

function connectionRefused(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(connectionRefused);
  if ("code" in error && error.code === "ECONNREFUSED") return true;
  return "cause" in error && connectionRefused(error.cause);
}

/** Only an explicit connection refusal establishes that there is no listener. */
export async function probeOllama({
  baseUrl = OLLAMA_BASE_URL,
  timeoutMs = 2500,
}: { baseUrl?: string; timeoutMs?: number } = {}): Promise<OllamaProbe> {
  const signal = AbortSignal.timeout(timeoutMs);
  let connected = false;
  try {
    const response = await fetch(`${baseUrl}/api/version`, { signal });
    connected = true;
    if (!response.ok) {
      await response.body?.cancel();
      return { state: "unresponsive", detail: `The Ollama endpoint returned HTTP ${response.status}.` };
    }
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "version" in body && typeof body.version === "string" && body.version.trim())
      return { state: "ready", version: body.version };
    return { state: "unresponsive", detail: "The endpoint did not return a valid Ollama version." };
  } catch (error) {
    if (!connected && !signal.aborted && connectionRefused(error)) return { state: "absent" };
    return {
      state: "unresponsive",
      detail: signal.aborted ? "The Ollama endpoint is taking too long to respond." : "The Ollama endpoint could not be verified.",
    };
  }
}

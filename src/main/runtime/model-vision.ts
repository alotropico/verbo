import { OLLAMA_BASE_URL } from "../../shared/config";

const known = new Map<string, boolean>();

export function modelSupportsVision(model: string): boolean {
  return known.get(model) === true;
}

export function clearModelVision(): void {
  known.clear();
}

export async function refreshModelVision(
  model: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${OLLAMA_BASE_URL}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      known.set(model, false);
      return false;
    }
    const json = (await response.json()) as { capabilities?: unknown };
    const supported =
      Array.isArray(json.capabilities) && json.capabilities.includes("vision");
    known.set(model, supported);
    return supported;
  } catch {
    known.set(model, false);
    return false;
  }
}

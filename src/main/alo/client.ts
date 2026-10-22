import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { BRIDGE_VERSION, MAX_FRAME_BYTES, bridgeResponseSchema, type BridgeRequest } from "./contracts";
import { aloRuntime } from "./runtime";

type Input = Omit<BridgeRequest, "version" | "id">;
const cancellation = new AsyncLocalStorage<AbortSignal | undefined>();
export function withAloSignal<T>(signal: AbortSignal | undefined, run: () => T): T {
  return cancellation.run(signal, run);
}
export function currentAloSignal(): AbortSignal | undefined {
  return cancellation.getStore();
}
export class AloCallError extends Error {
  constructor(
    message: string,
    readonly code: "cancelled" | "timeout" | "unavailable",
    readonly dispatched: boolean,
  ) {
    super(message);
    this.name = code === "cancelled" ? "AbortError" : "AloCallError";
  }
}
function decode(output: string, id: string): unknown {
  const response = bridgeResponseSchema.parse(JSON.parse(output));
  if (response.id !== id) throw new Error("Alo response identity mismatch.");
  if (!response.ok) throw new Error(response.error.summary);
  return response.result;
}
function encode(input: Input): { id: string; frame: string } {
  const id = randomUUID();
  const frame = JSON.stringify({ version: BRIDGE_VERSION, id, ...input });
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new Error("Alo request exceeds its bound.");
  return { id, frame };
}
export async function aloCall(input: Input, signal?: AbortSignal): Promise<unknown> {
  signal ??= currentAloSignal();
  if (signal?.aborted) throw new AloCallError("Alo call cancelled before dispatch.", "cancelled", false);
  let runtime: ReturnType<typeof aloRuntime>;
  let encoded: ReturnType<typeof encode>;
  try {
    runtime = aloRuntime();
    encoded = encode(input);
  } catch (error) {
    throw new AloCallError(error instanceof Error ? error.message : "Alo is unavailable.", "unavailable", false);
  }
  const { id, frame } = encoded;
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.node, [runtime.entry, "--machine", "--profile", runtime.profile], {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    const output: Buffer[] = [];
    let bytes = 0,
      settled = false;
    let pendingError: AloCallError | undefined;
    const abort = (): void => stop(new AloCallError("Alo call cancelled.", "cancelled", true));
    const executing = input.method === "invoke" || input.method === "tool" || input.method === "operations.decide";
    const timer = setTimeout(() => stop(new AloCallError("Alo call timed out.", "timeout", true)), executing ? 75000 : 10000);
    function stop(error: AloCallError): void {
      if (settled || pendingError) return;
      pendingError = error;
      child.stdin.destroy();
      child.kill();
      // Settle on close so an aborted caller does not leave a live child behind.
    }
    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) {
        reject(error);
        return;
      }
      try {
        resolve(decode(Buffer.concat(output).toString("utf8"), id));
      } catch (failure) {
        reject(new AloCallError(failure instanceof Error ? failure.message : "Invalid Alo response.", "unavailable", true));
      }
    }
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      // Failed spawn has no running process to await or kill.
      if (!child.pid) finish(new AloCallError(error.message, "unavailable", false));
      else stop(new AloCallError(error.message, "unavailable", true));
    });
    child.stdin.on("error", (error) => stop(new AloCallError(error.message, "unavailable", true)));
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_FRAME_BYTES) stop(new AloCallError("Alo response exceeds its bound.", "unavailable", true));
      else if (!pendingError) output.push(chunk);
    });
    child.stderr.resume();
    child.on("close", (code) =>
      finish(pendingError ?? (code === 0 ? undefined : new AloCallError("Alo child failed. No retry was attempted.", "unavailable", true))),
    );
    if (signal?.aborted) abort();
    else child.stdin.end(frame);
  });
}

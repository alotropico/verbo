import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  BRIDGE_VERSION,
  MAX_FRAME_BYTES,
  bridgeResponseSchema,
  type BridgeRequest,
} from "./contracts";
import { aloRuntime } from "./runtime";

type Input = Omit<BridgeRequest, "version" | "id">;
function decode(output: string, id: string): unknown {
  const response = bridgeResponseSchema.parse(JSON.parse(output));
  if (response.id !== id) throw new Error("Alo response identity mismatch.");
  if (!response.ok) throw new Error(response.error.summary);
  return response.result;
}
function encode(input: Input): { id: string; frame: string } {
  const id = randomUUID();
  const frame = JSON.stringify({ version: BRIDGE_VERSION, id, ...input });
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES)
    throw new Error("Alo request exceeds its bound.");
  return { id, frame };
}
/** Synchronous only for the existing synchronous catalog/settings read boundary. */
export function aloCallSync(input: Input): unknown {
  const runtime = aloRuntime();
  const { id, frame } = encode(input);
  const child = spawnSync(
    runtime.node,
    [runtime.entry, "--machine", "--profile", runtime.profile],
    {
      input: frame,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: 10000,
      maxBuffer: MAX_FRAME_BYTES,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    },
  );
  if (child.error || child.status !== 0)
    throw new Error("Alo is unavailable or returned an invalid response.");
  return decode(child.stdout, id);
}
export async function aloCall(
  input: Input,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const runtime = aloRuntime();
  const { id, frame } = encode(input);
  return new Promise((resolve, reject) => {
    const child = spawn(
      runtime.node,
      [runtime.entry, "--machine", "--profile", runtime.profile],
      {
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    const output: Buffer[] = [];
    let bytes = 0,
      settled = false;
    const abort = (): void => finish(new Error("Alo call cancelled."));
    const timer = setTimeout(
      () => finish(new Error("Alo call timed out.")),
      75000,
    );
    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) {
        child.kill();
        reject(error);
        return;
      }
      try {
        resolve(decode(Buffer.concat(output).toString("utf8"), id));
      } catch (failure) {
        reject(failure);
      }
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    child.on("error", (error) => finish(error));
    child.stdin.on("error", (error) => finish(error));
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_FRAME_BYTES)
        finish(new Error("Alo response exceeds its bound."));
      else output.push(chunk);
    });
    child.stderr.resume();
    child.on("close", (code) =>
      finish(
        code === 0
          ? undefined
          : new Error("Alo child failed. No retry was attempted."),
      ),
    );
    child.stdin.end(frame);
  });
}

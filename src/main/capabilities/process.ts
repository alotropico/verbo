import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, extname } from "node:path";
import type { ActionContext, Capability } from "./registry";
import type { ActionResult } from "../../shared/action-contract";

export type ProcessOutcome = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  spawned: boolean;
};
export type TrustedProcess = {
  executable: string;
  args: Array<{ literal: string } | { parameter: string }>;
  cwd: (args: Record<string, unknown>) => string;
  authorizeCwd: (path: string) => boolean;
  timeoutMs: number;
  successCodes: number[];
  parse: (outcome: ProcessOutcome) => ActionResult;
};
const OUTPUT_LIMIT = 64 * 1024;
const ENVIRONMENT_KEYS = [
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "HOME",
  "LANG",
];

function identity(path: string): string {
  const stat = statSync(path);
  if (!stat.isFile())
    throw new Error("The registered executable is not a file.");
  return `${realpathSync(path)}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

/** Only backend code can construct an adapter; parameters never select programs. */
export function bindTrustedProcess(
  definition: TrustedProcess,
): Capability["execute"] {
  if (
    !isAbsolute(definition.executable) ||
    [".cmd", ".bat", ".ps1"].includes(
      extname(definition.executable).toLowerCase(),
    )
  ) {
    throw new Error("Register an absolute executable, not a shell launcher.");
  }
  if (
    !Number.isInteger(definition.timeoutMs) ||
    definition.timeoutMs < 1 ||
    definition.timeoutMs > 60_000
  )
    throw new Error("Invalid process timeout.");
  const registeredIdentity = identity(definition.executable);
  return async (
    args: Record<string, unknown>,
    context: ActionContext,
  ): Promise<ActionResult> => {
    if (identity(definition.executable) !== registeredIdentity)
      throw new Error("The registered executable changed.");
    const requestedCwd = definition.cwd(args);
    if (!isAbsolute(requestedCwd) || !definition.authorizeCwd(requestedCwd))
      throw new Error("Working directory is not authorized.");
    const cwd = realpathSync(requestedCwd);
    if (!definition.authorizeCwd(cwd) || !statSync(cwd).isDirectory())
      throw new Error("Working directory is not authorized.");
    const argv = definition.args.map((binding) => {
      const value =
        "literal" in binding ? binding.literal : args[binding.parameter];
      if (
        typeof value !== "string" ||
        value.length > 32768 ||
        value.includes("\0")
      )
        throw new Error("Invalid process argument.");
      return value;
    });
    const outcome = await runBoundedProcess({
      executable: definition.executable,
      args: argv,
      cwd,
      timeoutMs: definition.timeoutMs,
      signal: context.signal,
    });
    const result = definition.parse(outcome);
    if (outcome.cancelled)
      return {
        ...result,
        status: "cancelled",
        code: "cancelled",
        summary: "Operation cancelled.",
      };
    if (outcome.timedOut)
      return {
        ...result,
        status: "error",
        code: "timeout",
        summary: "Operation failed: the process timed out.",
      };
    if (!outcome.spawned)
      return {
        ...result,
        status: "error",
        code: "spawn_failed",
        summary: "Operation failed: the registered process could not start.",
      };
    if (
      (outcome.code === null ||
        !definition.successCodes.includes(outcome.code)) &&
      result.status === "success"
    )
      return {
        ...result,
        status: "error",
        code: "process_exit",
        summary: `Operation failed: the process did not exit successfully (${outcome.code ?? "signal"}).`,
      };
    return result;
  };
}

/** Internal primitive, never exposed through IPC. Callers validate executable/cwd. */
export function runBoundedProcess(input: {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Used only by the fixed Windows AGS shim adapter; never a command argument. */
  windowsVerbatimArguments?: boolean;
}): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const outcome: ProcessOutcome = {
      code: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      cancelled: false,
      spawned: false,
    };
    if (input.signal?.aborted) {
      resolve({ ...outcome, cancelled: true });
      return;
    }
    const env = Object.fromEntries(
      ENVIRONMENT_KEYS.flatMap((key) =>
        process.env[key] ? [[key, process.env[key]!]] : [],
      ),
    );
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: input.windowsVerbatimArguments ?? false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const interrupt = (): void => {
      child.kill();
      forceTimer ??= setTimeout(() => {
        child.kill("SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, 1000);
    };
    const timer = setTimeout(() => {
      outcome.timedOut = true;
      interrupt();
    }, input.timeoutMs);
    const cancel = (): void => {
      outcome.cancelled = true;
      interrupt();
    };
    input.signal?.addEventListener("abort", cancel, { once: true });
    child.on("spawn", () => {
      outcome.spawned = true;
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      outcome.stdout = (outcome.stdout + chunk).slice(0, OUTPUT_LIMIT);
    });
    child.stderr?.on("data", (chunk: string) => {
      outcome.stderr = (outcome.stderr + chunk).slice(0, OUTPUT_LIMIT);
    });
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      input.signal?.removeEventListener("abort", cancel);
      resolve(outcome);
    };
    child.on("error", finish);
    child.on("close", (code) => {
      outcome.code = code;
      finish();
    });
    if (input.signal?.aborted) cancel();
  });
}

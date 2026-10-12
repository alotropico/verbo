import { execFileSync } from "node:child_process";
import { AGS_CHECK_ARGS } from "../../shared/ags";
import { agsArtifactsSince, type AgsArtifact } from "./metadata";

export type AgsCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type AgsCommandRunner = (input: {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}) => AgsCommandResult;

const TIMEOUT_MS = 20_000;
const OUTPUT_CAP = 1500;

export function execFileAgs(input: {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}): AgsCommandResult {
  try {
    const stdout = execFileSync(input.executable, [...input.args], {
      cwd: input.cwd,
      timeout: input.timeoutMs,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      shell: false,
      encoding: "utf8",
    });
    return { code: 0, stdout, stderr: "", timedOut: false };
  } catch (caught) {
    const error = caught as {
      status?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      killed?: boolean;
      signal?: string;
    };
    return {
      code: typeof error.status === "number" ? error.status : 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
      timedOut: Boolean(error.killed || error.signal),
    };
  }
}

export function runAgsCheck(input: {
  executable: string;
  cwd: string;
  runner?: AgsCommandRunner;
  now?: number;
}): {
  args: readonly string[];
  result: AgsCommandResult;
  artifacts: AgsArtifact[];
} {
  const started = input.now ?? Date.now();
  const runner = input.runner ?? execFileAgs;
  const result = runner({
    executable: input.executable,
    args: AGS_CHECK_ARGS,
    cwd: input.cwd,
    timeoutMs: TIMEOUT_MS,
  });
  return {
    args: AGS_CHECK_ARGS,
    result: {
      ...result,
      stdout: result.stdout.slice(0, OUTPUT_CAP),
      stderr: result.stderr.slice(0, OUTPUT_CAP),
    },
    artifacts: agsArtifactsSince(input.cwd, started),
  };
}

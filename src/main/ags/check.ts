import { runBoundedProcess } from "../capabilities/process";
import { AGS_CHECK_ARGS } from "../../shared/ags";
import { agsArtifactsSince, type AgsArtifact } from "./metadata";
import { agsProcessInvocation } from "./executable";

export type AgsCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled?: boolean;
};

export type AgsCommandRunner = (input: {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}) => AgsCommandResult | Promise<AgsCommandResult>;

const TIMEOUT_MS = 20_000;
const OUTPUT_CAP = 1500;

export async function execFileAgs(input: {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<AgsCommandResult> {
  if (
    input.args.length !== AGS_CHECK_ARGS.length ||
    input.args.some((arg, index) => arg !== AGS_CHECK_ARGS[index])
  )
    throw new Error("The AGS adapter accepts only its fixed check command.");
  const result = await runBoundedProcess({
    ...input,
    ...agsProcessInvocation(input.executable),
  });
  return { ...result, code: result.code ?? 1 };
}

export async function runAgsCheck(input: {
  executable: string;
  cwd: string;
  runner?: AgsCommandRunner;
  now?: number;
  signal?: AbortSignal;
}): Promise<{
  args: readonly string[];
  result: AgsCommandResult;
  artifacts: AgsArtifact[];
}> {
  const started = input.now ?? Date.now();
  const runner = input.runner ?? execFileAgs;
  const result = await runner({
    executable: input.executable,
    args: AGS_CHECK_ARGS,
    cwd: input.cwd,
    timeoutMs: TIMEOUT_MS,
    ...(input.signal ? { signal: input.signal } : {}),
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

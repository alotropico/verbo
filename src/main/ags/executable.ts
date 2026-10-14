import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, win32 } from "node:path";
import { agsExecutableAllowed, AGS_CHECK_ARGS } from "../../shared/ags";
import { executableIdentity } from "../software/executable-identity";

export function agsExecutableIdentity(candidate: string): string {
  if (
    !isAbsolute(candidate) ||
    !agsExecutableAllowed(candidate) ||
    lstatSync(candidate).isSymbolicLink()
  )
    throw new Error("Choose the registered AGS program itself.");
  const path = realpathSync(candidate);
  const stat = statSync(path);
  if (!stat.isFile())
    throw new Error("That AGS program is not a regular file.");
  if (extname(path).toLowerCase() === ".exe")
    return executableIdentity(path).identity;
  if (stat.size > 512 * 1024)
    throw new Error("The AGS launcher exceeds its size limit.");
  return `${path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}
export function agsProcessInvocation(executable: string): {
  executable: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
} {
  if (!isAbsolute(executable) || !agsExecutableAllowed(executable))
    throw new Error("Unregistered AGS program.");
  if (extname(executable).toLowerCase() !== ".cmd")
    return { executable, args: [...AGS_CHECK_ARGS] };
  if (process.platform !== "win32" || /[%!&|<>^"\r\n\0]/u.test(executable))
    throw new Error(
      "This AGS launcher path is unsafe for the fixed Windows adapter. Use a path without shell characters.",
    );
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !win32.isAbsolute(systemRoot))
    throw new Error("Windows command interpreter is unavailable.");
  const interpreter = win32.join(systemRoot, "System32", "cmd.exe");
  executableIdentity(interpreter);
  // Exact registered launcher + one static command, with expansion disabled. No model text enters cmd.
  return {
    executable: interpreter,
    args: ["/d", "/v:off", "/s", "/c", `""${executable}" check"`],
    windowsVerbatimArguments: true,
  };
}

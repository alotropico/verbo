import { existsSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { executableIdentity } from "./verified-executable";

export function browserExecutable(configured = ""): string {
  const candidates = configured
    ? [configured]
    : [
        join(
          process.env.ProgramFiles ?? "C:/Program Files",
          "Google/Chrome/Application/chrome.exe",
        ),
        join(
          process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)",
          "Google/Chrome/Application/chrome.exe",
        ),
        join(
          process.env.LOCALAPPDATA ?? "",
          "Google/Chrome/Application/chrome.exe",
        ),
        join(
          process.env.ProgramFiles ?? "C:/Program Files",
          "Microsoft/Edge/Application/msedge.exe",
        ),
        join(
          process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)",
          "Microsoft/Edge/Application/msedge.exe",
        ),
      ];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) || !existsSync(candidate)) continue;
    try {
      const { path } = executableIdentity(candidate);
      if (["chrome.exe", "msedge.exe"].includes(basename(path).toLowerCase()))
        return path;
    } catch {
      /* Try another installed browser; never launch unverified files. */
    }
  }
  throw new Error("browser_unavailable");
}

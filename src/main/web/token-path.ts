import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function webTokenPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const root = env.LOCALAPPDATA || join(home, "AppData", "Local");
  return join(root, "Verbo", "web-token");
}

export function readWebToken(filePath = webTokenPath()): string | null {
  try {
    const token = readFileSync(filePath, "utf8").trim();
    if (token.length < 16 || /[\r\n]/.test(token)) return null;
    return token;
  } catch {
    return null;
  }
}

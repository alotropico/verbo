import { readdirSync, readFileSync, statSync } from "node:fs";
import { win32 } from "node:path";
import { resolveContainedPath } from "../files/windows-containment";

export type ProjectFacts = {
  name: string;
  description: string;
  stack: string[];
  vcs: "none" | "git";
  head: string;
  writeGranted: false;
};

const MARKERS: Array<[string, string]> = [
  ["package.json", "node"],
  ["pyproject.toml", "python"],
  ["Cargo.toml", "rust"],
  ["go.mod", "go"],
];

function containedFile(
  root: string,
  ...parts: string[]
): string | null {
  const candidate = win32.join(root, ...parts);
  const resolved = resolveContainedPath(root, candidate, "read");
  if (!resolved.ok || !resolved.exists) return null;
  try {
    if (!statSync(resolved.finalPath).isFile()) return null;
  } catch {
    return null;
  }
  return resolved.finalPath;
}

function readCapped(filePath: string, maxBytes: number): string | null {
  try {
    const size = statSync(filePath).size;
    if (size > maxBytes) return null;
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function firstLine(text: string, max: number): string {
  const line = text
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .find((item) => item.length > 0 && !item.startsWith("#"));
  return (line ?? "").replace(/[\u0000-\u001f]/gu, "").slice(0, max);
}

function quoted(text: string, key: string): string {
  const match = new RegExp(
    `^${key}\\s*=\\s*"([^"\\n]{1,80})"`,
    "mu",
  ).exec(text);
  return match?.[1]?.trim() ?? "";
}

export function inspectProject(root: string, folderName: string): ProjectFacts {
  const stack: string[] = [];
  let name = folderName;
  let description = "";
  const packagePath = containedFile(root, "package.json");
  if (packagePath) {
    stack.push("node");
    const raw = readCapped(packagePath, 65_536);
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          const record = parsed as Record<string, unknown>;
          if (typeof record.name === "string") name = record.name.slice(0, 80);
          if (typeof record.description === "string") {
            description = record.description.slice(0, 180);
          }
        }
      } catch {
        description = "";
      }
    }
  }
  for (const [file, label] of MARKERS) {
    if (label === "node") continue;
    if (containedFile(root, file)) stack.push(label);
  }
  try {
    const names = readdirSync(root);
    if (names.some((entry) => /\.(csproj|sln)$/iu.test(entry))) stack.push("dotnet");
  } catch {
    // The root listing is optional stack evidence.
  }
  if (!description) {
    const readme =
      containedFile(root, "README.md") ?? containedFile(root, "README.txt");
    if (readme) description = firstLine(readCapped(readme, 8192) ?? "", 180);
  }
  const cargo = containedFile(root, "Cargo.toml");
  if (cargo && name === folderName) {
    const cargoName = quoted(readCapped(cargo, 8192) ?? "", "name");
    if (cargoName) name = cargoName;
  }
  const gomod = containedFile(root, "go.mod");
  if (gomod && name === folderName) {
    const moduleLine = (readCapped(gomod, 4096) ?? "")
      .split(/\r?\n/u)
      .find((line) => line.startsWith("module "));
    const moduleName = moduleLine?.slice("module ".length).trim() ?? "";
    if (moduleName) name = moduleName.slice(0, 80);
  }
  let vcs: ProjectFacts["vcs"] = "none";
  let head = "";
  const headFile = containedFile(root, ".git", "HEAD");
  if (headFile) {
    vcs = "git";
    const line = (readCapped(headFile, 256) ?? "").split(/\r?\n/u)[0] ?? "";
    if (/^ref: refs\/[A-Za-z0-9._/-]{1,80}$/u.test(line) || /^[0-9a-f]{40}$/u.test(line)) {
      head = line;
    }
  }
  return {
    name,
    description,
    stack,
    vcs,
    head,
    writeGranted: false,
  };
}

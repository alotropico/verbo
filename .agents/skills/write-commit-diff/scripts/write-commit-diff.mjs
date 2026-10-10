#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MODES = ["commits", "range", "staged", "changes", "untracked", "current", "working", "commit"];
const DIFF = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];

export class DiffError extends Error {}

function git(args, cwd, { allow = [0], input } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", input, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw new DiffError(`git failed to start: ${result.error.message}`);
  if (!allow.includes(result.status)) throw new DiffError(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  return result;
}

export function repoRoot(start) {
  return path.resolve(git(["rev-parse", "--show-toplevel"], start).stdout.trim());
}

export function diffBaseName(name) {
  if (!name || name !== path.basename(name) || /[\\/:*?"<>|\u0000-\u001f\u007f]/.test(name)) throw new DiffError(`Name must be a plain filename: ${name}`);
  const base = name.toLowerCase().endsWith(".diff") ? name.slice(0, -5) : name;
  if (!base || base === "." || base === "..") throw new DiffError(`Name must contain a filename: ${name}`);
  return base;
}

export function positiveCount(value, available) {
  if (!/^[1-9]\d*$/.test(String(value))) throw new DiffError(`Commit count must be a positive integer: ${value}`);
  const count = Number(value);
  if (!Number.isSafeInteger(count)) throw new DiffError(`Commit count is too large: ${value}`);
  if (available != null && count > available) throw new DiffError(`N=${count} exceeds commit count on HEAD (${available})`);
  return count;
}

export function commitCount(repo) {
  return Number(git(["rev-list", "--first-parent", "--count", "HEAD"], repo).stdout.trim());
}

function resolveCommit(repo, ref) {
  if (typeof ref !== "string" || !ref || ref.startsWith("-")) throw new DiffError(`Invalid commit reference: ${ref}`);
  return git(["rev-parse", "--verify", `${ref}^{commit}`], repo).stdout.trim();
}

export function parseDiffArgs(argv, { name } = {}) {
  const words = [...argv];
  const selectors = new Set(["current", "unstaged", "changes", "staged", "untracked"]);
  const legacyLimits = { commits: [3, 3], range: [3, 4], current: [2, 3], staged: [2, 2], changes: [2, 2], untracked: [2, 2] };
  const legacy = words[0] === "commits" || words[0] === "range" ||
    (Object.hasOwn(legacyLimits, words[0]) && words.length >= 2 && !selectors.has(words[1]) && !/^\d+$/.test(words[1]));
  if (legacy) {
    const [min, max] = legacyLimits[words[0]];
    if (words.length < min || words.length > max) throw new DiffError("Invalid diff mode arguments; see ags help diff.");
    const [mode, oldName, a, b] = words;
    return { name: diffBaseName(name ?? oldName), mode, extra: mode === "range" ? { from: a, to: b || "HEAD" } : a };
  }
  const output = diffBaseName(name ?? "changes");
  if (words[0] === "commit") {
    if (words.length !== 2 || !words[1] || words[1].startsWith("-")) throw new DiffError("Use commit <hash-or-ref> for one particular commit.");
    return { name: output, mode: "commit", extra: words[1] };
  }
  if (words.length === 1 && /^[0-9a-f]{4,64}$/i.test(words[0]) && (!/^\d+$/.test(words[0]) || [40, 64].includes(words[0].length))) {
    return { name: output, mode: "commit", extra: words[0] };
  }
  if (!words.length) return { name: output, mode: "current", extra: undefined };
  let current = false;
  let staged = false;
  let count;
  let untracked = false;
  for (const word of words) {
    if (["current", "unstaged", "changes"].includes(word) && !current && !untracked) current = true;
    else if (word === "staged" && !staged && !untracked) staged = true;
    else if (word === "untracked" && words.length === 1) untracked = true;
    else if (/^\d+$/.test(word) && count == null) count = positiveCount(word);
    else throw new DiffError(`Invalid or repeated diff selector: ${word}. Use current, staged, a positive count, or one commit hash.`);
  }
  if (current && count != null && !staged) throw new DiffError("Include staged when combining current changes with commits: ags diff current staged <N>.");
  return { name: output, mode: untracked ? "untracked" : current ? (staged ? "current" : "working") : staged ? "staged" : "commits", extra: count };
}

export function emptyTreeId(repo) {
  const id = git(["hash-object", "-t", "tree", "--stdin"], repo, { input: "" }).stdout.trim();
  if (!id) throw new DiffError("Git did not return an empty tree id");
  return id;
}

function resolveBase(repo, value) {
  const available = commitCount(repo);
  const count = positiveCount(value, available);
  if (count < available) {
    resolveCommit(repo, `HEAD~${count}`);
    return { count, base: `HEAD~${count}`, atRoot: false };
  }
  return { count, base: emptyTreeId(repo), atRoot: true };
}

function gitBytes(repo, args) {
  return Buffer.from(git(["-c", "core.quotepath=false", ...args], repo).stdout || "", "utf8");
}

let nullSpec;

function gitNullSpec(repo) {
  if (nullSpec) return nullSpec;
  const probe = path.join(os.tmpdir(), `write-commit-diff-null-${process.pid}.txt`);
  fs.writeFileSync(probe, "probe\n");
  try {
    for (const candidate of process.platform === "win32" ? ["NUL", "/dev/null"] : ["/dev/null"]) {
      const result = git(["diff", "--no-color", "--no-index", "--", candidate, probe], repo, { allow: [0, 1, 128, 129] });
      if ((result.status === 0 || result.status === 1) && (result.stdout || "").includes(path.basename(probe))) {
        nullSpec = candidate;
        return nullSpec;
      }
    }
  } finally {
    fs.rmSync(probe, { force: true });
  }
  throw new DiffError("Git did not accept a null diff target");
}

function untrackedPatch(repo) {
  // Diff artifacts must not become input on a subsequent run in an unprepared repository.
  const files = (git(["-c", "core.quotepath=false", "ls-files", "-z", "--others", "--exclude-standard", "--", ".", ":(exclude).tmp/**"], repo).stdout || "").split("\0").filter(Boolean);
  const parts = [];
  for (const file of files) {
    const result = git(["-c", "core.quotepath=false", ...DIFF, "--no-index", "--", gitNullSpec(repo), file], repo, { allow: [0, 1, 128, 129] });
    const stderr = result.stderr || "";
    if ((result.status !== 0 && result.status !== 1) || /^(?:error|fatal):/m.test(stderr)) {
      throw new DiffError(`Untracked diff failed for ${file}: ${stderr.trim() || "git diff failed"}`);
    }
    parts.push(Buffer.from(result.stdout || "", "utf8"));
  }
  return Buffer.concat(parts);
}

export function writeDiff(start, name = "changes", mode = "current", extra) {
  const repo = repoRoot(start);
  const base = diffBaseName(name);
  let tracked = Buffer.alloc(0);
  let summary = mode;
  if (mode === "commits") {
    const resolved = resolveBase(repo, extra);
    summary = resolved.atRoot ? `commits ${resolved.base}..HEAD` : `commits HEAD~${resolved.count}..HEAD`;
    tracked = gitBytes(repo, resolved.atRoot ? [...DIFF, resolved.base, "HEAD"] : [...DIFF, `HEAD~${resolved.count}..HEAD`]);
  } else if (mode === "range") {
    const from = resolveCommit(repo, extra?.from);
    const to = resolveCommit(repo, extra?.to || "HEAD");
    summary = `range ${from}..${to}`;
    tracked = gitBytes(repo, [...DIFF, `${from}..${to}`]);
  } else if (mode === "staged") {
    if (extra != null) {
      const resolved = resolveBase(repo, extra);
      summary = `staged plus last ${resolved.count} commits`;
      tracked = gitBytes(repo, [...DIFF, "--cached", resolved.base]);
    } else tracked = gitBytes(repo, [...DIFF, "--cached"]);
  } else if (mode === "changes" || mode === "working") {
    tracked = gitBytes(repo, DIFF);
    if (mode === "working") summary = "unstaged plus untracked";
  } else if (mode === "commit") {
    const commit = resolveCommit(repo, extra);
    const parent = git(["rev-list", "--parents", "-n", "1", commit], repo).stdout.trim().split(/\s+/)[1] || emptyTreeId(repo);
    tracked = gitBytes(repo, [...DIFF, parent, commit]);
    summary = `commit ${commit} (against first parent or empty tree)`;
  } else if (mode === "current") {
    if (extra) {
      const resolved = resolveBase(repo, extra);
      summary = resolved.atRoot ? `current ${resolved.base}` : `current HEAD~${resolved.count}`;
      tracked = gitBytes(repo, [...DIFF, resolved.atRoot ? resolved.base : `HEAD~${resolved.count}`]);
    } else {
      const head = git(["rev-parse", "--verify", "HEAD"], repo, { allow: [0, 128] });
      const base = head.status === 0 ? "HEAD" : emptyTreeId(repo);
      summary = head.status === 0 ? "current HEAD" : "current empty tree (no commits yet)";
      tracked = gitBytes(repo, [...DIFF, base]);
    }
  } else if (mode !== "untracked") {
    throw new DiffError(`Unknown mode: ${mode}. Modes: ${MODES.join(", ")}`);
  }
  const body = Buffer.concat([tracked, ["untracked", "current", "working"].includes(mode) ? untrackedPatch(repo) : Buffer.alloc(0)]);
  const dir = path.join(repo, ".tmp", "scratch");
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `${base}.diff`);
  const staging = `${outPath}.${process.pid}.tmp`;
  fs.writeFileSync(staging, body);
  fs.renameSync(staging, outPath);
  return { path: outPath, bytes: body.length, summary };
}

const USAGE = `Usage: node .agents/skills/write-commit-diff/scripts/write-commit-diff.mjs [current] [staged] [N | hash] [--name <filename>]
  no arguments               current + staged; output .tmp/scratch/changes.diff
  current                    unstaged changes plus untracked files (alias: unstaged)
  staged                     the index against HEAD
  N                          last N first-parent commits
  current staged [N]         net changes, optionally including the last N commits
  hash | commit <ref>        that commit's patch, against its first parent
Legacy named modes:
  commits <name> <N>          last N first-parent commits
  range <name> <from> [to]    from..to (to defaults to HEAD)
  staged <name>               the index against HEAD
  changes <name>              the working tree against the index
  untracked <name>            untracked files, not ignored
  current <name> [N]          working tree against HEAD (or HEAD~N), plus untracked files`;

export function main(argv, cwd = process.cwd()) {
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  let request;
  try {
    const words = [];
    let name;
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === "--name") {
        if (name != null || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new DiffError("--name takes one plain filename.");
        name = argv[++i];
      } else if (argv[i].startsWith("--")) throw new DiffError(`Unknown flag: ${argv[i]}`);
      else words.push(argv[i]);
    }
    request = parseDiffArgs(words, { name });
  } catch (error) {
    if (!(error instanceof DiffError)) throw error;
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  try {
    const result = writeDiff(cwd, request.name, request.mode, request.extra);
    process.stdout.write(`${result.path}\nbytes: ${result.bytes}\nsource: ${result.summary}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof DiffError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));

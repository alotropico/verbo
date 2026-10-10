---
name: write-commit-diff
description: Write a git diff to a file under .tmp/scratch/ instead of printing it, for one particular commit, the last N commits, a commit range, staged or unstaged changes, untracked files, or the whole working tree. Use when the user asks to generate, create, make or export a diff, and before writing commit messages, reviews or summaries that need the full diff.
---

# Write a commit diff

Use this skill when a task needs a full diff: drafting commit messages, reviewing changes, or summarizing work. Also use it when the user asks to generate, create or make a diff of commits, export a commit range, write the last N commits to a file, or write staged, unstaged, untracked or current changes to a file. The script writes the diff to a file so it does not flood the conversation.

Use the script instead of pasting `git diff` or `git show` output into the conversation or redirecting a hand-written `git diff` into a file. Do not use this skill for ordinary `git diff` or `git status` checks while coding.

## Command

Run from the repository root:

```text
node .agents/skills/write-commit-diff/scripts/write-commit-diff.mjs [current] [staged] [N or hash] [--name <filename>]
```

With no arguments, write unstaged, staged and untracked changes to `.tmp/scratch/changes.diff`. Use `current` (or `unstaged`) for unstaged plus untracked changes, `staged` for the index, a positive integer for the last N first-parent commits, or a hash for that particular commit. `commit <ref>` also accepts references such as `HEAD~2` and disambiguates all-numeric abbreviated hashes. A merge commit uses its first parent; a root commit uses the empty tree.

Combine `current staged`, or `current staged 1` to include the last commit. Combined output is one net diff between snapshots, so cancelling changes disappear. `staged 1` combines the index with the last commit. Counts combined with `current` require `staged` too. `--name review` writes `.tmp/scratch/review.diff` instead of the default.

When the `ags` command is available, `ags diff` offers the same selectors and `--name`, plus `--route <repository>`. It works without this skill being installed. The direct Node helper remains independent of AGS.

Legacy named modes remain available:

- `commits <name> <N>`: the last N first-parent commits on HEAD.
- `range <name> <from> [to]`: `from..to`; `to` defaults to `HEAD`.
- `staged <name>`: the index against HEAD.
- `changes <name>`: the working tree against the index.
- `untracked <name>`: untracked files that git does not ignore.
- `current <name> [N]`: the working tree against HEAD, or against `HEAD~N`, plus untracked files.

`<name>` is a plain file name; `.diff` is added when missing.

To diff another checkout, run the same script with that checkout as the working directory; the file is written to that checkout's `.tmp/scratch/`.

## Procedure

1. Pick the mode from the request. If the range or the commit count is ambiguous, ask once.
2. Use the default filename unless the user supplies a name or a ticket/branch-specific name is useful; pass that name with `--name`.
3. Run the script.
4. For `commits` and `current` with N, list the commits the diff covers with `git log --oneline --first-parent -n <N>`; for `range`, with `git log --oneline <from>..<to>`.
5. Reply with the path, the size and the commits covered, not the diff content. Paste the diff only when the user asks to see it in the conversation.

## Output

The script writes `.tmp/scratch/<name>.diff` in the repository, replacing a file of the same name, and prints its path, its size in bytes and the diff source. Untracked `.tmp/` artifacts are excluded so generated output cannot feed into the next diff. It never changes the index or source files. Read the file when you need the diff.

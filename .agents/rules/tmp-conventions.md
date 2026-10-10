---
description: Creating, moving, or archiving files under .tmp/.
---

# `.tmp` conventions

These conventions apply in every repository, including AGS itself. `.tmp/` holds local working material; it is gitignored and must stay readable by agents.

## Layout

```text
.tmp/
  plans/            plans and specs; multi-file plans as folders
  records/          records of finished work, and handoffs
  scratch/          disposable output: diffs, logs, experiments
  archive/YYYY-MM/  finished or stale material moved out of the way
  ags/              reserved for the ags command: backups/, locks/, reports/, snapshots/
```

Do not write under `.tmp/ags/`; only the `ags` command does.

## Names

- New files: `YYYY-MM-DD-kebab-slug.md`. New folders: `YYYY-MM-DD-kebab-slug/`.
- Sweep manifests use `YYYY-MM-DD-sweep.json` under `records/` for `ags tmp clean`.
- Existing files are not renamed, including when they are archived.

## No trigger names

- No dot-folders anywhere under `.tmp/`.
- No instruction entry files anywhere under `.tmp/`: `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md`. Harnesses load them from subfolders and would bring old guidance back to life.
- When moving old agent setup into `.tmp/`, rename such files and folders, for example `.cursor/` to `_cursor/` and `AGENTS.md` to `AGENTS.md.bak`.

## Ignoring and reading

- `.tmp/` is ignored through git only: a `.gitignore` rule or the git exclude file. Never list `.tmp/` in `.cursorignore`, `.cursorindexingignore` or another harness ignore file; `.cursorignore` blocks agent reads.
- Read `.tmp/` files by direct path. Built-in search, Grep, `@` suggestions and indexing may skip them, and may return no matches rather than an error.
- To search `.tmp/`, use the terminal: `rg --no-ignore <pattern> .tmp/`, or `rg --hidden --no-ignore <pattern>` from the repository root.

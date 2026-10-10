<!-- AGS:BEGIN 6.0.1 76904a25cfdf -->
## AGS

- Host settings are in `.agents/ags.yaml`. Use values exactly as written; if a value a task needs is missing, ask the user. Host guidance wins on facts and formats: `AGENTS.md` outside this block, host rules, and `.agents/local/` override AGS defaults. AGS safety constraints never yield.
- Before using a skill, read `.agents/local/<skill-name>.md` if it exists; it refines the skill for this repository. AGS owns its installed files. Keep repository-specific differences in host guidance; edits to AGS files are reviewed on update. After substantive work, use `report-usage` when available.
- Apply guidance to the requested task and the code it must touch. Reading guidance never authorizes unrelated cleanup, modernization, review, or refactoring. Default to concise output and minimal narration without redundant explanation; preserve decision-relevant evidence and caveats.
- Prefer `rg --files` for file listing and `rg` for text search when available. Otherwise use the next suitable tool without changing the task.
- Require fresh evidence appropriate to claims that work is done, fixed, working, or passing. A change is done when the repository's verification passes. Use the `check` skill when it is installed. Keep verification proportional to the change; formatting and type checks alone do not prove UI behavior.

Read a rule before work that matches its condition:

- `.agents/rules/tmp-conventions.md`: Creating, moving, or archiving files under .tmp/.
- `.agents/rules/workspace-operations.md`: Pure file moves, renames, copies, or choosing optional navigation/indexing tools; ordinary repository search alone does not qualify.
<!-- AGS:END -->

## Theme and Mantine

Semantic color/radius tokens live in `src/renderer/src/assets/globals.css`. Mantine consumes them through `src/renderer/src/theme/mantine.ts` (`ThemeProvider`). Renderer styles use CSS modules plus those tokens (`cx` from `@/lib/cx`). Do not add Tailwind. Use installed skills `mantine-form`, `mantine-combobox`, and `mantine-custom-components`; read `.agents/local/<skill-name>.md` first. Do not add a second palette.

---
name: report-usage
description: Record an observed AGS skill/action outcome after meaningful implementation, investigation, planning or validation, when reporting is enabled and the installed ags mechanism is available. Skip individual reads/tool calls and duplicate outcomes.
---

# Report guidance usage

After substantive work—completed meaningful implementation, investigation, planning or validation—record only the skill or action actually used and its known outcome. Skip this skill when `ags` is unavailable, the installed reporting mechanism is unavailable, or reporting is disabled. Do not submit an event for every read/tool call or duplicate reports for one known action outcome.

## Command

Run from the repository root:

```text
ags report usage --route . --action plan-work --event-type task --outcome completed
```

- `--label` is an optional short description of the task.
- Supply `--harness` and `--session` only when the environment already exposes them.
- Use `--prompt` only for already available prompt text. AGS normalizes whitespace and caps the preview at 160 characters.
- Supply already available attachment paths with repeatable `--attachment`. AGS retains only basenames.
- When `.agents/ags.yaml` has `reporting: false`, the command records nothing and still succeeds.

Example:

```text
ags report usage --route . --action check --event-type validation --outcome passed --label "Validate export feature"
```

## Deterministic reporting

Do not invent engagement scores, infer sentiment or reconstruct unavailable context. Legacy explicit `--file <installed-path>=<level>` inputs remain accepted for existing callers; this workflow generates no new levels.

Events stay in the host-local `.tmp/ags/reports/usage.jsonl` spool. `ags report collect` copies new event ids into central segments without changing host spools. `ags report compact` groups closed segments mechanically. `ags report clean --before YYYY-MM` previews central cleanup and retains its cutoff to prevent historical events returning.

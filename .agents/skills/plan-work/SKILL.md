---
name: plan-work
description: Create an execution procedure in .tmp/plans/ when the user asks to plan or record decisions, or work involves ambiguity, architectural choices, risky migration, or uncertain cross-system sequencing. Skip obvious, bounded, low-risk work even across several files; file count alone is not a trigger. Do not create a separate specification unless requested.
---

# Plan work

**Trigger:** The user asks to plan or record decisions, or the work needs decisions about ambiguous requirements, unclear dependencies, architecture, risky migration, or uncertain implementation sequencing.

An ordinary plan is an execution procedure for an understood objective. It may record assumptions, but it does not create a separate specification or conduct a general backlog sweep. If the requested artifact could materially mean a specification, a deferred inventory, or a spec-first plan, ask one concise question instead of silently choosing.

## When to plan

- Architectural or broad refactor work with meaningful dependency or cross-system coordination questions; file count alone is not a reason to plan.
- Risky migrations or an uncertain implementation sequence.
- Unclear ownership, acceptance criteria or migration boundaries.
- A library or tradeoff choice that is not obvious and that future readers need to understand.

Unless the user asks for a plan, skip planning for obvious, bounded, well-understood, low-risk work even when several files are involved. Implement mechanical changes directly, then perform the narrow verification appropriate to the change.

## Where plans go

- Write the plan in this repository at `.tmp/plans/YYYY-MM-DD-kebab-slug.md`, following the `tmp-conventions` rule. A plan with supporting files, such as to-dos or open questions, becomes a folder of the same name.
- Do not create plan stores under `.agents/` or `.cursor/`.
- When the user or host guidance asks for it, draft the plan where the team reviews it with the change instead, such as a merge request description or a ticket, or in another location they name.

## Plan skeleton

```markdown
# Title

## Goal
## Non-goals
## Approach
## Files likely touched
## Risks / open questions
## Decision log
## Done when
```

Record each non-obvious decision in the plan as you go, one line each: a library pick, a rejected approach, an ownership ruling.

If the work reveals a genuine deferral, use the `manage-backlog` skill when it is installed. Do not turn non-goals or rejected approaches into backlog entries automatically.

## When the work is done

- Move a plan worth keeping to `.tmp/records/`, and a stale one to `.tmp/archive/YYYY-MM/`. Do not edit a record afterwards beyond a short completion note.
- Promote only durable architectural notes into the repository's tracked documentation, where host guidance names a place for them. Ephemeral to-dos stay out of tracked history.
- Do not leave imperative living-document instructions in tracked guidance.

## Done when

- The acceptance criteria in the plan are met.
- Verification follows the repository's own scripts; use the `check` skill when it is installed. Do not invent a package manager or a script name.
- The decision log captures anything non-obvious.
- Work meant to stay local, such as a plan alone, leaves tracked files unchanged.

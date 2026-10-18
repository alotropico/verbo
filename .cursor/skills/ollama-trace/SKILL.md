---
name: ollama-trace
description: >-
  Diagnose a pasted Ollama–Verbo chat register, tool trace, or commander run.
  Find the first meaningful deviation, verify what the model actually
  received, and fix the smallest supported cause. Use for actions.invoke
  failures, capability-discovery confusion, repeated calls, or inference
  and deadline stops. Changes may belong in tool exposure, result delivery,
  tool interfaces, command definitions, or agent context. Add functionality
  only when no existing form covers the task.
---

# Ollama trace

Review the supplied failure against the current implementation. Keep the
change local to the evidence. Do not audit unrelated commands, rewrite the
helper tree, or expand the task into a general architecture review.

The model is small. Make legal calls explicit through ids, field names,
quoted enums, syntax, and valid examples. Do not assume that every failure
means those instructions need more text.

## First deviation, supported cause

Walk the register in order: user request, tool call, tool result, next call.

Identify the first meaningful deviation:
- An invalid tool name or argument.
- A valid call used for the wrong purpose.
- A result that omits information needed for the correct next step.
- An unsupported interpretation of the user request.
- Repeated discovery after sufficient information is available.

A `describe` call after `search` is not inherently a mistake.

Distinguish:
- **Observed deviation:** what the trace proves happened.
- **Supported cause:** what the trace and implementation establish.
- **Hypothesis:** an explanation that still needs verification.

The earliest invalid call is a starting point, not automatically the root
cause. Later calls caused by that deviation are cascade. Leave their
individual command definitions unchanged unless independent evidence
requires another fix.

The budget or deadline line is the stop, not a diagnosis. Do not raise
budgets to accommodate a loop.

## Verify the model-facing boundary

Before editing catalog text, inspect the actual request at the failing
boundary, or the code that builds it:

- System and profile instructions.
- Available tool names, descriptions, and schemas.
- User request and relevant history.
- Tool results delivered back to the model.
- The execution entry point for discovered commands.
- Any filtering, truncation, compaction, or dynamic tool exposure.

A UI export containing a result does not prove that the same content
reached the model. A command appearing in search does not prove that the
model had a usable way to invoke it.

Inspect only the boundary relevant to this failure. If the necessary
payload or code is unavailable, state the limitation and the smallest
inspection needed. Do not replace missing evidence with speculative edits.

Do not increase the context window without evidence that required content
was lost or could not fit. Distinguish context capacity, output limits,
inference-call limits, and wall-clock deadlines.

## Choose the repair layer

| Evidence | Repair layer |
| --- | --- |
| Execution entry point absent or incorrectly exposed | Tool registration or exposure |
| Required result content omitted, misrouted, or truncated | Request construction or result delivery |
| Tool name, argument, or error confuses capabilities with filesystem operations | Shared tool interface |
| Correct command absent or outranked for the request | Search metadata or ranking |
| Existing legal form missing from syntax or examples | Command definition |
| Schema accepts incompatible argument combinations | Args schema |
| Required effect has no supported form | Existing command extension, then new command if necessary |
| Model ignores an adequate interface and complete instructions | Controlled replay to isolate model behavior |
| Host policy blocks the operation | Report the policy setting; preserve the boundary |

Fix a shared interface defect once in the project. Do not duplicate its
workaround across command descriptions or add an incident-specific rule
to this skill.

When syntax and examples already cover the task, **no catalog edit** is
a valid outcome.

## Not a catalog change

`write_denied`, a scope that is not writable, approval requirements, and
cancellation are host policy. Name the setting that blocked the call.
Do not add a command or weaken a check to bypass it.

An unambiguous user request does not need rewriting because the model
misused a tool.

Do not add a duplicate command when an existing effect already covers
the request.

## Command and discovery classes

Use this table only after checking exposure and delivery.

| Class | Evidence | Targeted response |
| --- | --- | --- |
| Invented id | `unknown_action` or unregistered name | Check the invocation contract. Add an alias or search tags only when they address the demonstrated mismatch. |
| Ambiguous name | `ambiguous_command` | Show the full id in the relevant description and example. Avoid colliding aliases. |
| Search miss | Empty results, unsuitable ranking, or invalid query | Distinguish query misuse from ranking failure. Adjust tags or ranking only for a demonstrated retrieval problem. Query length is 2–64 characters. |
| Discovery did not lead to execution | Correct command returned, followed by unrelated or repeated discovery | Verify execution access and result delivery. If both are correct, inspect tool distinctions and replay. Do not automatically rewrite the covering command. |
| Narrow form | Model builds a path list, page loop, or one-file sequence despite an available wide form | Make the wide form the primary syntax and example if it is not already. Otherwise investigate why it was ignored. |
| Mixed fields | Args combine incompatible forms | Show explicit syntax alternatives. Reshape the schema only when it accepts invalid combinations or cannot express the legal branches clearly. |
| Bad value | Invalid enum, scope, or regex | Name legal values or constraints in the relevant schema, example, or error. Distinguish invalid scope syntax from policy denial. |
| Wrong command | A different command is selected for an already supported effect | Clarify the demonstrated distinction. Use one local description change where sufficient. |
| Misread request | Selected effect conflicts with user text | Inspect the instruction or context that could explain it. No new command when the intended effect already exists. |
| Repeated call | Same invalid call recurs without new information | Fix the initial cause. Inspect existing recovery behavior before adding another repeat ban. |
| Misleading error | Failure text sends the model toward an unsuitable workaround | Correct that error to explain the legal next step. |
| False success | Assistant claims a status the tool did not return | Check result delivery and existing reporting instructions. Add text only for an uncovered gap. |
| Guessed parameter | Model supplies unsupported information or searches for a question command | Check the existing commander question-field contract. Correct its exposure or wording only where the trace demonstrates a gap. |
| Execution outside the catalog | Model bypasses the registered execution contract | Inspect the existing boundary and available registered action. Do not add shell access as a workaround. |

## Levers

Choose the smallest change supported by the diagnosis. This is not a
mandatory order:

- Tool registration, exposure, or invocation contract.
- Tool-result delivery or request construction.
- Tool name, argument name, schema description, or corrective error.
- Search tags, aliases, or ranking.
- A valid command example.
- Explicit syntax alternatives, widest relevant form first.
- One command description sentence.
- Shared instructions when the defect spans commands and existing text
  does not already cover it.
- A parameter or schema branch when required functionality is absent.
- A new command only for an unsupported effect.

Do not change search tags when retrieval already found the right command.
Do not add instructions that merely repeat text already delivered.

Stop when the supported cause is addressed and verification passes.

## Where

Use these as starting points; verify them against the current repository.

- Chat system text:
  `src/main/runtime/context-builder.ts` (`CORE_INSTRUCTIONS`).
- Shared chat and commander selection text:
  `src/main/agents/command-selection.ts` (`COMMAND_SELECTION`).
- Commander profile:
  `src/main/agents/profiles.ts`.
- Tool descriptions sent to Ollama:
  `src/main/runtime/ollama-wire.ts`.
- Command metadata:
  `CommandDefinition` in `src/main/capabilities/`.
- Args schema:
  The command's zod object.
- Shared file-mutation schemas:
  `src/shared/file-mutation.ts`.
- Generated syntax and search ranking:
  `src/main/capabilities/registry.ts`.

When `syntax` is omitted, inspect `argumentSyntax` / `renderSchema`.
A flat optional object may render as one argument bag instead of legal
alternatives.

Verify current search weights before changing ranking. Existing weights
are tags 60, description 30, syntax 20, plus 40 when the query contains the
last id segment. These values describe implementation, not desired behavior.

Every `example` must pass `args.safeParse`. Registry loading rejects
invalid examples.

## Parameters, branches, and new commands

Use these for missing functionality, not to optimize a later cascade.

- **Parameter:** extend the existing schema, handler, syntax, and example.
- **Branches:** show explicit syntax alternatives first. Reshape the schema
  when it accepts incompatible combinations or cannot describe legal forms.
- **New command:** add only a new effect. Include its definition, handler
  binding, and a parsing example.

If a new command changes the pinned shipped id count and snapshot in
`catalog-contract.test.ts`, update both and inspect the snapshot diff.

## Verify contracts and behavior separately

### Contract verification

Run tests relevant to the changed surface.

Search ranking:
`src/main/capabilities/registry.test.ts`.

Shipped command metadata and args:
`src/main/capabilities/catalog-contract.test.ts`.

Snapshot:
`src/main/capabilities/__snapshots__/catalog-contract.test.ts.snap`.

    pnpm exec vitest run src/main/capabilities/registry.test.ts src/main/capabilities/catalog-contract.test.ts

For runtime or wire changes, use the relevant existing tests there.
Add a focused schema test when needed. Keep snapshot changes limited to
the intended entries.

Passing contract tests does not establish that Qwen follows the interface.

### Behavioral verification

When local model execution is available, replay the failing request under
the same model and relevant settings. Use a disposable fixture or
non-mutating execution capture for file operations.

Check whether the model reaches the intended execution call and whether
the original confusion recurs. Do not require one exact discovery sequence
when several valid sequences exist.

If the cause remains unclear, compare:
- The existing discovery flow.
- The same request with only the relevant execution tool exposed.

Success with direct exposure narrows the investigation toward discovery
and presentation; it does not prove the specific cause.

Record model, relevant settings, and observed outcome. One successful
replay is a smoke check, not an accuracy estimate.

If replay is unavailable, report contract verification as complete and
behavioral verification as unverified.

## Reply

Keep the report short:

- First observed deviation: call, args, and result.
- Supported cause, or remaining hypothesis and missing evidence.
- Repair layer and exact change, or why no edit is warranted.
- Cascade left unchanged.
- Contract and behavioral verification, reported separately.
- Policy block, if applicable.
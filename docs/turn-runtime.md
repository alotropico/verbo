# Turn lifecycle and workflows

Electron main owns admission, execution and final persistence through [Controller](../src/main/runtime/controller.ts). The renderer observes events through the preload MessagePort. It does not execute tools or persist a competing assistant final. Immediate turns, promoted queue items, typed slash commands and literal voice slash commands share the existing foreground dispatcher.

## Final responses and recovery

Controller saves one canonical assistant message before emitting `done`, closing the live mapping and releasing the foreground slot. Promoted follow-ups extend the persisted reply on their selected branch. Idempotent history writes and branch-head comparisons protect newer branches from stale renderer echoes or late save acknowledgments.

A failed final save retains the frozen response and stable IDs, performs bounded automatic retries, and holds the queue. **Retry saving response** retries persistence only. It cannot call a model, restart a workflow or dispatch commands. Pending final snapshots survive process restart; multiple snapshots recover one at a time. Reopening a chat reattaches to its canonical live response. Closing observation leaves main execution running; **Stop generating** requests cancellation without releasing the slot ahead of final persistence.

Conversation regeneration can produce another answer. Regenerating an operational response reuses saved receipt evidence instead of repeating effects.

## Workflows and compatibility worker

The versioned workflow runner is enabled by default. Set `VERBO_WORKFLOW_V1=0` to select the compatibility worker; `1` also explicitly selects workflows. Both paths use Controller, the existing request gate, registry, approvals, receipts, resources and history. Changing the flag does not replay completed effects or discard pending execution evidence.

Three versioned, data-only definitions are registered:

- **Conversational:** one tool-free invocation, published directly.
- **Commander:** bounded registered-command work, followed by receipt-grounded presentation.
- **Obsidian:** a local decision and exhaustive write/edit/move/rename/delete routes. Writer creates a managed body reference; Commander integrates or saves it. Edit retains the original path, revision and body reference across read, Writer and save steps.

Definitions validate schema references, producer availability, branch coverage, forward jumps, model profiles and declared grants. The interpreter owns sequential transitions and terminal settlement. Reserved nested workflow references validate ID/version/contracts, but nested execution returns explicit `not_supported` in V1.

Execution revisions, step results, action attempts, turn links and content pins are durable. Continuation validates branch, execution/version/revision, typed answer, target snapshot and approved guidance. Removed/reassigned guidance or changed source files block continuation. Queued input interrupts pending work: a preexisting queued “yes” cannot answer a later question. Interrupted effects require reconciliation and are not replayed automatically.

## Instructions, context and authority

The compatibility worker uses [CORE_INSTRUCTIONS](../src/main/runtime/context-builder.ts). Workflow invocations use immutable host instructions, role instructions and explicit step context/tool/skill selection (CTS). Renderer system text is not authority. Titles and welcome lines retain their separate bounded prompts.

Decision, Conversational and Writer/Responder omit tools from the wire and are denied direct backend dispatch. Commander discovers and invokes registered commands through `capabilities.list`, `capabilities.search`, `capabilities.describe` and `actions.invoke`. Trusted invocation policy survives aliases, composites, recreated registries, private prepared children and approval continuation. Shell, PowerShell and JavaScript evaluation remain prohibited.

Notes have explicit recipients: Decision, Conversational, Writer and Commander. Legacy notes remain editable, unassigned and uninjected until assigned in Settings. New notes visibly default to Conversational. Role context meters reflect the selected audience. Guidance files require explicit scope/audience/hash assignments; installed AGS guidance is never automatically loaded into application agents.

Routing uses bounded cached folder metadata, descriptions and shallow directory names. A named vault resolves through trusted scopes; a sole vault can be selected automatically. Several unnamed vaults require clarification even if a model supplies a plausible alias. Generic default-save settings never choose a vault.

## Budgets, receipts and presentation

The existing tool worker permits eight model rounds and twenty tool requests. A second consecutive equivalent request returns the prior result as feedback; a third stops without execution. Canonical aliases and stable serialization normalize equivalent requests. Differing arguments or intervening work reset the serial guard. Every announced call receives a terminal result, including unattempted calls after cancellation, capacity limits or a trusted terminal result.

Workflow invocations share a turn deadline, sixteen inference admissions with presentation capacity reserved, and twenty tool admissions. Each role also has a bounded model profile. Invalid Commander final JSON can receive one tool-free contract repair; completed effects cannot repeat during that repair. A domain `not_supported` receipt terminates its Obsidian step without another backend search.

Operational presentation uses a frozen outcome from persisted execution and receipts. Writer/Responder must preserve status, receipt IDs, exact findings and required questions. Deterministic fallback handles invalid output, failure, deadlines or cancellation. Worker/decision prose is not final user text. Global routing and workflow stages remain in the durable timeline; newer execution revisions suppress old pending indicators.

## Obsidian boundary and rollout

Canonical vault classification covers generic filesystem operations too: parent aliases, absolute/missing paths, ancestors, nested scopes, batch/undo and both endpoints. Native writes cannot bypass a vault's backend policy. Unknown stored backend/version identities are rejected.

The CLI adapter requires explicit executable/application identity, profile, unique vault mapping and qualification. Read/create/move/rename candidates have disposable fixture evidence. Full edit lacks equivalent revision CAS; vault-local trash does not establish system Recycle Bin equivalence. Cold-vault reads can return empty output with exit code zero; exact verification rejects these. Related note resources are observed within explicit bounds, with truncation reported. Complete effects and atomic undo are not guaranteed.

The user approved activation of the qualified subset on 2026-10-16. Installation-specific activation is read from `obsidian-qualification.json` in Verbo's userData directory; the adapter rechecks executable/application identity before dispatch. Missing, disabled or stale qualification leaves operations unavailable. Unsupported edit/delete retain their branches and precise results. Module-wide passthrough discloses exact invocation and unknown effects; action-only grants cannot become arbitrary CLI authority. No native vault fallback is available.

The wrapper explicitly registers `obsidian.help`, `obsidian.read`, `obsidian.create`, `obsidian.move`, `obsidian.rename`, `obsidian.edit`, `obsidian.delete` and `obsidian.cli`, with individual schemas, help and support limitations. They appear in command discovery and Settings. Typed slash commands bypass model routing:

```text
/obsidian.help {"vault":"garden","command":"create"}
/obsidian.read {"vault":"garden","path":"Inbox/Idea.md"}
/obsidian.create {"vault":"garden","path":"Inbox/New.md","content":"# New note\nText"}
/obsidian.move {"vault":"garden","path":"Inbox/Idea.md","to":"Archive/Idea.md"}
/obsidian.rename {"vault":"garden","path":"Archive/Idea.md","to":"Archive/New name.md"}
```

Replace `garden` with a configured vault scope ID or alias. Obsidian's CLI must be enabled, its vault registry must uniquely match the configured scope, and scope permissions still apply. Create/move/rename require approval. Natural-language workflows retain the measured model limitations (occasional missing actions or unnecessary questions); deterministic slash commands provide direct access to the registered wrapper.

## Verification

Run tests, both TypeScript checks, lint and electron-vite build. Deterministic fixtures prove lifecycle, authorization and interpreter behavior; they do not establish local-model compliance. Opt-in Qwen routing/composition benchmarks and isolated Obsidian qualification retain per-case evidence under ignored `.tmp/scratch/`. Rendered Electron acceptance uses disposable profiles and covers Stop, queue promotion, reload, injected save failure and actual process-restart recovery without replay.

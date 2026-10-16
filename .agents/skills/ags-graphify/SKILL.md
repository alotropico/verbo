---
name: ags-graphify
description: Use an available Graphify executable for local deterministic cross-file dependency tracing, impact investigation, architecture relationships, or callers/callees when a graph materially helps. Skip ordinary repository search and simple known-file changes.
---

# Local Graphify operations

**Trigger:** Cross-file dependency tracing, impact investigation, architecture relationships, or callers/callees where graph information materially helps. Ordinary repository search and a simple known-file change are near misses; executable availability alone does not activate this skill.

Revalidate the repository-local Graphify executable first, then machine PATH. Inspect that executable's help to select a documented local deterministic operation. Respect host-owned restrictions and keep generated artifacts in `.tmp/scratch/`.

Automatic AGS workflows may use only local deterministic processing. Do not enable external models, hosted inference or operations spending API credits automatically. Model-assisted behavior requires an explicit user request for that behavior, even if the executable is available or credentials exist. If a command's cost boundary is unclear, do not run it.

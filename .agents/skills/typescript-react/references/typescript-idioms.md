# TypeScript idioms

Apply to TypeScript types/utilities in any environment, including backend code. Repository facts and the established surrounding style win on aliases, libraries, folder layout and verification commands. Do not load React implementation or client performance for pure TypeScript work.

## Shared implementation conventions

- Import groups: packages, then the repository's aliased modules, then relative paths. Use the repository's path aliases where it defines them and relative paths elsewhere.
- Combine imports from the same module. With the automatic JSX runtime, do not import React only for JSX. When no formatter decides line breaks, put an import of three or more names on one line per name.
- Prefer named exports for components and utilities.
- Use an options object when named arguments make a call clearer.

## Types

- Prefer `type` over `interface`.
- Prefer `string[]` and `Record<string, T>` where they fit.
- Prefer `Pick` and `Omit` when a type overlaps an existing one.
- Optional parameters and fields use `?`, not `| undefined`.
- Put defaults in destructuring, not in a trailing `??` after a field access.
- Prefer enums for finite discrete sets, such as lifecycle states or resource kinds.
- Existing loose typing is known debt. Do not add new `any`, and do not build workarounds around the old ones unless the task is about them.

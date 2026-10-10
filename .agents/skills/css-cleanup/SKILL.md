---
name: css-cleanup
description: >-
  Audit CSS and SCSS for unused selectors, unused variables, and redundant
  overrides, write a report first, then remove confirmed findings
  conservatively. Use only when the user asks to clean up styles, find unused
  CSS, or audit CSS modules or SCSS files.
---

# CSS cleanup

**Trigger:** The user explicitly asks to clean up styles, find unused CSS, or audit CSS modules or SCSS files.

## Host settings

Read these keys from `.agents/ags.yaml` at the repository root before acting. Use each value exactly as written; never guess one. If a required key is missing, stop and ask the user.

- `checks.type`: the `package.json` script that runs the type check. If the key is empty or missing, skip the type check.
- `checks.lint`: the `package.json` script that runs the linter. If the key is empty or missing, skip the lint check.
- `checks.prettier`: the `package.json` script that checks formatting without writing files. If the key is empty or missing, skip the format check.

## Established command

Read the `package.json` scripts and the settings above before deciding that no audit exists. If an established audit, lint or cleanup script already covers the styles in scope, run it; use the `check` skill when it is installed and the matching setting is configured. Use the grep audit below only when no dedicated script exists.

## Scope

Take the scope from the request. Without one, cover every `.scss`, `.module.scss` and `.css` file in the repository's source.

Report, but never remove automatically:

- shared or global stylesheets that many modules or pages rely on;
- modules with dynamic class access;
- classes that are also referenced as plain strings, for example in legacy markup, string concatenation or `classNames(...)` calls.

## Grep audit

For each CSS module in scope:

1. Find the importers of that module in the repository's source and tests, for example `rg -l "Name.module.scss" src tests --glob "*.{ts,tsx}"`.
2. Note each binding name (`style`, `tableStyle` and so on).
3. Collect referenced class ids: `style.<class>`, `style?.['<class>']`, and `style["<class>"]`.
4. List top-level classes and `&.modifier` blocks defined in the module.
5. Unused candidates are defined classes minus referenced classes.
6. If any importer uses dynamic access (`style[<variable>]` or `style?.[variable]`), mark every selector of that module suspicious. Its selectors cannot be proven unused.

Then extend the audit beyond modules:

- Global classes: search the raw class name across markup, templates and TS or JS, including string concatenation and `classNames(...)` calls.
- Variables: for each SCSS variable and CSS custom property defined in scope, search for reads across all style files, and for custom properties also in TS or TSX.
- Redundant overrides: a declaration that repeats the value the element already gets from the cascade, or one that a later declaration in the same scope always overrides.

Classify each finding as unused (no hits), suspicious (dynamic construction is possible, for example a string template near a partial match), or used.

## Report

Before deleting anything, write the findings to `.tmp/records/YYYY-MM-DD-css-audit-<scope>.md`: each finding with its file, line, kind and classification. Summarize it for the user and stop. Delete only what the user confirms, or in the same pass when the user explicitly asked to audit and fix at once.

## Confirm and remove

Prefer keeping a selector over risking a broken view.

1. Re-grep each confirmed candidate across the source and tests. Skip it when any hit remains.
2. Before deleting a selector, check nested selectors, `composes`, and global or marker classes that other stylesheets target.
3. Never delete a suspicious finding without verifying how the dynamic usage resolves.
4. Remove in small batches:
   - Delete only unused selector blocks, variables and overrides. Preserve nesting.
   - For `&.modifier`, remove only that modifier block.
   - An orphan module that nothing imports may be deleted after confirmation.
5. When a component references a class its module lacks, add the class if the element needs that styling. If the reference is dead, delete the whole `className` prop rather than leaving an empty `className=""`. Do not delete a class that is used elsewhere.

## Verify

Run the checks from Host settings that are configured, through the `check` skill when it is installed. Otherwise run an explicit existing script. Do not invent a package manager or a script name. Prefer these checks over a full production build unless the user asks for a build.

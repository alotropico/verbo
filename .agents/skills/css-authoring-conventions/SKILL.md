---
name: css-authoring-conventions
description: >-
  Apply concise CSS and SCSS authoring conventions when creating, editing,
  refactoring, or reviewing styles, styling-related markup, or component style
  APIs such as theme, variant, and size.
---

# CSS authoring conventions

**Trigger:** Creating, editing, refactoring, or reviewing CSS or SCSS, the markup that exists to carry those styles, or component style APIs such as `theme`, `variant`, and `size`.

These are strong defaults, not mechanical transforms. Correctness, accessibility, semantic HTML, cascade behavior, and established host conventions win. Discover the host's style files, its global theme layer, and its shared components before assuming a directory layout.

Apply the defaults to the styles the task touches. Do not mass-rewrite legacy or unrelated styles unless the task explicitly edits them.

Unused-class audit: [`css-cleanup`](../css-cleanup/SKILL.md). To normalize theme-token usage, use the `css-theme-tokens` skill when it is installed.

## Declarations

- Prefer CSS shorthand when it is fully equivalent and will not reset an intentional longhand or hide a later override.
- Prefer fewer declarations. Do not declare a value that cascade, inheritance, a component default, or the same scope already provides, unless explicitness has a concrete purpose.
- Use the repository's theme tokens for colors, spacing, lengths, radii, shadows, and durations when a token exists. Do not hard-code a raw hex value or a magic pixel value in its place.
- Order declarations alphabetically by default. Preserve intentional order for shorthand and longhand interactions, fallbacks, vendor-prefixed pairs, repeated-property overrides, and other dependencies. Put `@extend` and `@include` before the sorted properties of the same block, and nested rules after the declarations. Do not mechanically reorder nested rules or Sass directives.

## Selectors and naming

- Do not introduce tag selectors inside a CSS module. Styles for bare elements belong in the host's global theme layer.
- Inside CSS modules, use module-owned semantic or hierarchical class names that describe the element's role.
- Do not introduce ad hoc utility-like class names, in CSS modules or globally. Reuse the host's documented global primitives when they fit; reusing them is not a violation. Do not invent a new global utility for one-off feature UI; style it in a co-located module.
- Do not add a meaningless class to a `div` only to satisfy a naming pattern. Prefer a semantic element where practical, or name the `div` for its actual structural role.
- Preserve the global marker classes that module-owned elements need to take part in global shell selectors.
- In Sass, use `&` for modifiers, states, pseudo-classes, and pseudo-elements when it clearly expresses the relationship to the parent selector.

## Markup and composition

- Prefer existing layout and UI components over one-off structural markup: the UI library's components first, then the repository's shared components, then the feature's own components.
- Escalate styling in this order: the component's props and variants; the host's global override stylesheet; a component-specific CSS module as the last resort. Never add custom styles for something the props already support.
- Consolidate genuinely repeated markup-and-style structures across files into a reusable component. Do not abstract coincidental or trivial duplication.
- Avoid an unnecessary wrapper when a fragment or an existing element already provides the layout, semantics, accessibility, styling, and event behavior.
- Floating surfaces such as popovers, menus, and tooltips must layer above their owner. Use the host's portal component and its z-index tokens; do not invent one-off large `z-index` values.

## Modern CSS

- Prefer logical properties when the dimension is logically block or inline and the host does not require a physical side.
- Prefer CSS over JavaScript when CSS expresses the behavior more simply and maintainably. Consider relational selectors, container queries, and anchor positioning when they remove script or coupling.
- Verify the exact feature and variant against the host's browser policy. When the host defines none, target current Chrome, Firefox, and Safari.
- Do not add a routine JavaScript fallback once the selected feature is supported across that target unless product or host requirements call for one.
- Apply modernization only to new or task-touched styles and markup. A broader rewrite requires an explicit refactor request.
- Add a declaration only for a demonstrated layout or behavior need; modern syntax is not a reason to prescribe habitual boilerplate.

## Component boundaries

- When adding style-related props such as `theme`, `variant`, or `size`, reuse or derive them from existing exported types for the same concept, including the UI library's types. Do not duplicate an equivalent enum or string union.
- Keep local CSS at the boundary the component already owns. Do not invent a parallel style API when the component already exposes the needed variant.

## Verify

Use the `check` skill when it is installed. Otherwise run the repository's existing type, lint, or format scripts. Do not invent a package manager or a script name.

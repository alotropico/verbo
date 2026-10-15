# UI styling

Verbo uses Mantine controls and assistant-ui chat primitives with co-located CSS modules. The renderer imports [`globals.css`](../src/renderer/src/assets/globals.css) once from `main.tsx`. PostCSS supplies Mantine's `rem()`, `em()`, and mixins; automatic pixel conversion stays off.

## Ownership and tokens

| Concern                                                               | Owner                                        |
| --------------------------------------------------------------------- | -------------------------------------------- |
| Colors, decorative gradients, surfaces, shadows, radii, shared motion | `assets/globals.css`                         |
| Mantine variables, variants, and component defaults                   | `theme/mantine.ts`                           |
| Shared Mantine component selectors                                    | `theme/mantine.module.css`                   |
| Feature layout and states                                             | Adjacent `*.module.css`                      |
| Chat composition and state                                            | assistant-ui primitives and runtime adapters |

Use existing semantic colors such as `--primary`, `--foreground`, `--muted-foreground`, and `--destructive`. The orb fallback and textured shell also read their decorative colors from globals. `assets/base.css` and `assets/main.css` are legacy scaffold styles; the application entry point does not import them.

Mantine's spacing scale is `xs` = 10 px, `sm` = 12 px, `md` = 16 px, `lg` = 20 px, and `xl` = 32 px at the default scale. Use the matching `--mantine-spacing-*` token for spacing. Icon dimensions, measured geometry, borders, and animation offsets can keep local `rem()` values where no existing token fits.

`--radius-sm`, `--radius-md`, and `--radius-lg` serve feature surfaces. `--radius-control` provides the softer Mantine control radius; `--radius-panel` serves the composer and modal surfaces. `--radius-pill` serves round controls. Mantine's radius names are mapped in the theme and need not equal the similarly named feature radius.

## Authoring conventions

Prefer Mantine props and variants before adding CSS. Shared component overrides belong in the existing theme. Use module-owned classes for feature styling and `cx` from `@/lib/cx` for class composition. Preserve `aui-*` marker classes and `data-slot` hooks used by chat primitives and shell selectors.

Alphabetize independent declarations. Preserve the order of shorthands and longhands, vendor fallbacks, and intentional overrides. Custom properties can stay grouped before ordinary declarations. Use equivalent shorthands and logical spacing/border properties when they express the element's role. Keep selectors and nested rules in their cascade order.

Avoid bare tag selectors inside modules. Markdown assigns classes to its elements; web source rows use their own classes. Global element rules belong in `globals.css`. Keep one palette and the existing CSS module toolchain.

## Motion and floating surfaces

Shared motion tokens retain the current timings: `--duration-fast` = 150 ms, `--duration-control` = 180 ms, `--duration-normal` = 200 ms, and `--duration-slow` = 300 ms. Feature-specific animation timing and measured disclosure duration can remain local. Existing reduced-motion rules disable decorative movement where provided.

Use the UI library's portal and layer tokens for floating surfaces. Chat menus use `--mantine-z-index-popover`; the image zoom portal uses `--mantine-z-index-modal`. Small local stacking contexts, such as a composer footer, retain local layer numbers.

Modal visibility and payload lifetime are separate. Close by changing `opened`; clear the selected command or confirmation payload in `onExitTransitionEnd`. Reopening during exit must retain the new payload. This keeps titles, errors, and content stable during dismissal.

## Settings lifecycle

Settings renders only the active tab and command module. `SettingsSessionProvider`, `SettingsSession`, and `use-settings-draft` keep draft values and autosave controllers outside those views. Only mounted views subscribe. Session drafts survive tab changes and returning to chat within the current window; persisted settings live in backend storage.

The Other settings and Commands disclosures share two `localStorage` flags across modules. They start open and closed respectively. The All commands view always exposes the full table. Command tables have three columns, click-to-copy code labels, editable alias tags, details buttons, and save/error feedback without repeated idle hints.

## Verification

Use the repository's type checks, lint, formatting, and Vitest scripts. For layout or interaction changes, verify in Electron with isolated fixture data or a development window. Check wide and narrow Settings, scrolling tables, wrapped details, keyboard focus, modal exit content, menus, reduced motion, and chat auto-scroll spacing. A browser without the preload bridge cannot exercise the app's complete behavior.

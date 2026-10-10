# Verbo × mantine-custom-components

- Source of theme truth: `src/renderer/src/assets/globals.css` semantic tokens. Map component CSS variables onto `var(--background)`, `var(--primary)`, `var(--radius)`, and siblings.
- Do not extend `createTheme({ colors: ... })` with a second palette. Shared mapping is `src/renderer/src/theme/mantine.ts`.
- Register `Component.extend()` only through the existing `theme` object in that file.
- Styling toolchain is `postcss-preset-mantine` (`rem()`, `em()`, `alpha()`, `light-dark()`, mixins). Leave `autoRem` off.
- Shell and generic controls are Mantine (`AppShell`, `Input`, `Textarea`, `Tooltip`, `Modal`, `Avatar`, `Skeleton`). Semantic colors stay in `globals.css`.
- assistant-ui keeps chat composition (thread, composer, messages, thread list, tools, reasoning). Do not rewrite those as Mantine factories. Their CSS uses the same `rem()` and Mantine scale tokens.
- Disclosure panels stay `@base-ui/react/collapsible`. The chat catalog depends on that panel API.

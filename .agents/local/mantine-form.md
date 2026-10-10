# Verbo × mantine-form

- Semantic tokens live in `src/renderer/src/assets/globals.css`. Do not add a Mantine color palette.
- `ThemeProvider` already mounts `MantineProvider` with `forceColorScheme="dark"` and the shared CSS-variable resolver in `src/renderer/src/theme/mantine.ts`.
- Zod is already a dependency (`zod` v4). Prefer it for schema validation when adding `@mantine/form`.
- Install `@mantine/form` only when the first form is implemented.

# Verbo × mantine-combobox

- Style Combobox surfaces with existing tokens (`--background`, `--foreground`, `--border`, `--accent`, `--muted-foreground`). No hardcoded hex/oklch palettes.
- Prefer built-in `Select` / `MultiSelect` / `Autocomplete` / `TagsInput` unless the skill's custom Combobox path is required.
- `ThemeProvider` already wraps the renderer; do not nest another `MantineProvider`.

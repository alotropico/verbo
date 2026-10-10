import {
  createTheme,
  Combobox,
  defaultVariantColorsResolver,
  Input,
  InputWrapper,
  Modal,
  Tooltip,
  type CSSVariablesResolver,
  type VariantColorsResolver,
} from "@mantine/core";
import styles from "./mantine.module.css";

/** Shared semantic tokens from `globals.css` (`--background`, `--primary`, …). */
const semantic = {
  "--mantine-color-body": "var(--background)",
  "--mantine-color-text": "var(--foreground)",
  "--mantine-color-bright": "var(--foreground)",
  "--mantine-color-dimmed": "var(--muted-foreground)",
  "--mantine-color-placeholder": "var(--muted-foreground)",
  "--mantine-color-error": "var(--destructive)",
  "--mantine-color-anchor": "var(--primary)",
  "--mantine-color-default": "var(--card)",
  "--mantine-color-default-hover": "var(--accent)",
  "--mantine-color-default-color": "var(--card-foreground)",
  "--mantine-color-default-border": "var(--border)",
  "--mantine-color-disabled": "var(--muted)",
  "--mantine-color-disabled-color": "var(--muted-foreground)",
  "--mantine-color-disabled-border": "var(--border)",
  "--mantine-primary-color-filled": "var(--primary)",
  "--mantine-primary-color-filled-hover":
    "color-mix(in oklch, var(--primary) 80%, transparent)",
  "--mantine-primary-color-light": "var(--accent)",
  "--mantine-primary-color-light-hover": "var(--muted)",
  "--mantine-primary-color-light-color": "var(--accent-foreground)",
  "--mantine-primary-color-outline": "var(--primary)",
  "--mantine-primary-color-outline-hover": "var(--accent)",
} as const;

export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {
    "--mantine-radius-default": "var(--radius)",
    "--mantine-radius-sm": "calc(var(--radius) - 4px)",
    "--mantine-radius-md": "var(--radius)",
    "--mantine-radius-lg": "calc(var(--radius) + 4px)",
    "--mantine-font-family": "inherit",
    "--mantine-font-family-headings": "inherit",
    "--mantine-font-family-monospace":
      "var(--font-mono, ui-monospace, monospace)",
  },
  light: semantic,
  dark: semantic,
});

const variantColorResolver: VariantColorsResolver = (input) => {
  const isPrimary =
    input.color === undefined || input.color === input.theme.primaryColor;
  if (!isPrimary) return defaultVariantColorsResolver(input);

  switch (input.variant) {
    case "filled":
      return {
        background: "var(--primary)",
        hover: "color-mix(in oklch, var(--primary) 80%, transparent)",
        color: "var(--primary-foreground)",
        border: "transparent",
      };
    case "light":
      return {
        background: "var(--accent)",
        hover: "var(--muted)",
        color: "var(--accent-foreground)",
        border: "transparent",
      };
    case "outline":
      return {
        background: "transparent",
        hover: "var(--accent)",
        color: "var(--foreground)",
        border: "var(--border)",
      };
    case "subtle":
    case "transparent":
      return {
        background: "transparent",
        hover: "var(--accent)",
        color: "var(--foreground)",
        border: "transparent",
      };
    case "default":
      return {
        background: "var(--card)",
        hover: "var(--accent)",
        color: "var(--card-foreground)",
        border: "var(--border)",
      };
    default:
      return defaultVariantColorsResolver({
        ...input,
        color: input.theme.primaryColor,
      });
  }
};

export const theme = createTheme({
  cursorType: "pointer",
  defaultRadius: "md",
  variantColorResolver,
  components: {
    Input: Input.extend({ classNames: { input: styles.input } }),
    InputWrapper: InputWrapper.extend({ classNames: { label: styles.label } }),
    Modal: Modal.extend({
      classNames: {
        content: styles.modalContent,
        header: styles.modalHeader,
        title: styles.modalTitle,
        body: styles.modalBody,
      },
    }),
    Combobox: Combobox.extend({
      classNames: { dropdown: styles.dropdown, option: styles.option },
    }),
    Tooltip: Tooltip.extend({ classNames: { tooltip: styles.tooltip } }),
  },
});

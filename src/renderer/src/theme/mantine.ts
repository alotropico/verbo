import {
  createTheme,
  Button,
  Combobox,
  Select,
  MultiSelect,
  TagsInput,
  Autocomplete,
  defaultVariantColorsResolver,
  Input,
  InputWrapper,
  Modal,
  Slider,
  Switch,
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
    "--mantine-radius-sm": "var(--radius-sm)",
    "--mantine-radius-md": "var(--radius)",
    "--mantine-radius-lg": "var(--radius-control)",
    "--mantine-font-family": "inherit",
    "--mantine-font-family-headings": "inherit",
    "--mantine-font-family-monospace": "var(--font-mono)",
  },
  light: semantic,
  dark: semantic,
});

const variantColorResolver: VariantColorsResolver = (input) => {
  const isDestructive = input.color === "red";
  const isPrimary =
    input.color === undefined || input.color === input.theme.primaryColor;
  if (!isPrimary && !isDestructive) return defaultVariantColorsResolver(input);
  const color = isDestructive ? "var(--destructive)" : "var(--primary)";
  const tint = `color-mix(in oklab, ${color} 10%, transparent)`;

  switch (input.variant) {
    case "filled":
      return {
        background: color,
        hover: `color-mix(in oklab, ${color} 85%, var(--background))`,
        color: "var(--primary-foreground)",
        border: "1px solid transparent",
      };
    case "light":
      return {
        background: tint,
        hover: `color-mix(in oklab, ${color} 16%, transparent)`,
        color,
        border: "1px solid transparent",
      };
    case "outline":
      return {
        background: "transparent",
        hover: isDestructive ? tint : "var(--accent)",
        color: isDestructive ? color : "var(--foreground)",
        border: `1px solid ${isDestructive ? color : "var(--border)"}`,
      };
    case "subtle":
      return {
        background: "transparent",
        hover: isDestructive ? tint : "var(--accent)",
        color: isDestructive ? color : "var(--foreground)",
        border: "1px solid transparent",
      };
    case "transparent":
      return {
        background: "transparent",
        hover: "transparent",
        color: isDestructive ? color : "var(--foreground)",
        border: "0",
      };
    case "default":
      return {
        background: "var(--card)",
        hover: "var(--accent)",
        color: "var(--card-foreground)",
        border: "1px solid var(--border)",
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
    Button: Button.extend({
      defaultProps: { variant: "light", radius: "lg" },
      classNames: { root: styles.button },
    }),
    Input: Input.extend({ classNames: { input: styles.input } }),
    InputWrapper: InputWrapper.extend({
      classNames: { label: styles.label, description: styles.description },
    }),
    Switch: Switch.extend({
      defaultProps: { color: "var(--primary)", withThumbIndicator: false },
      classNames: {
        input: styles.switchInput,
        track: styles.switchTrack,
        thumb: styles.switchThumb,
        label: styles.switchLabel,
        description: styles.description,
      },
    }),
    Slider: Slider.extend({
      defaultProps: { color: "var(--primary)", size: "sm" },
      classNames: {
        root: styles.slider,
        thumb: styles.sliderThumb,
        label: styles.sliderLabel,
      },
    }),
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
    Select: Select.extend({
      defaultProps: { scrollAreaProps: { type: "auto" } },
      classNames: { dropdown: styles.dropdown, option: styles.option },
    }),
    MultiSelect: MultiSelect.extend({
      defaultProps: { scrollAreaProps: { type: "auto" } },
      classNames: { dropdown: styles.dropdown, option: styles.option },
    }),
    TagsInput: TagsInput.extend({
      defaultProps: { scrollAreaProps: { type: "auto" } },
      classNames: { dropdown: styles.dropdown, option: styles.option },
    }),
    Autocomplete: Autocomplete.extend({
      defaultProps: { scrollAreaProps: { type: "auto" } },
      classNames: { dropdown: styles.dropdown, option: styles.option },
    }),
    Tooltip: Tooltip.extend({ classNames: { tooltip: styles.tooltip } }),
  },
});

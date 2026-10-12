import { Group, Slider, Stack, Text, type SliderProps } from "@mantine/core";
import type { ReactElement } from "react";
import { SettingsLabel } from "./SettingsLabel";
import styles from "./SettingsSlider.module.css";

type SettingsSliderProps = Omit<SliderProps, "label"> & {
  label: string;
  description: string;
  display: string;
};

export function SettingsSlider({
  label,
  description,
  display,
  ...props
}: SettingsSliderProps): ReactElement {
  return (
    <Stack gap="xs" className={styles.field}>
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <SettingsLabel
          className={styles.label}
          label={label}
          tip={description}
        />
        <Text component="output" className={styles.value}>
          {display}
        </Text>
      </Group>
      <Slider
        {...props}
        label={display}
        thumbLabel={label}
        thumbValueText={display}
      />
    </Stack>
  );
}

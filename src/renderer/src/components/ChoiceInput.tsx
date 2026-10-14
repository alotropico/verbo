import { Select, TextInput, type SelectProps } from "@mantine/core";
import type { ReactElement } from "react";

type Option = { value: string; label: string };

function options(data: SelectProps["data"]): Option[] {
  if (!data) return [];
  const list: Option[] = [];
  for (const item of data) {
    if (typeof item === "string") {
      list.push({ value: item, label: item });
      continue;
    }
    if ("group" in item) {
      for (const child of item.items) {
        if (typeof child === "string")
          list.push({ value: child, label: child });
        else if ("value" in child) {
          list.push({
            value: child.value,
            label: "label" in child && child.label ? child.label : child.value,
          });
        }
      }
      continue;
    }
    list.push({ value: item.value, label: item.label ?? item.value });
  }
  return list;
}

export function ChoiceInput({
  data,
  value,
  ...props
}: SelectProps): ReactElement {
  const choices = options(data);
  if (choices.length === 1 && !props.clearable && !props.searchable) {
    const only = choices[0];
    return (
      <TextInput
        label={props.label}
        description={props.description}
        error={props.error}
        size={props.size}
        className={props.className}
        value={only?.label ?? ""}
        readOnly
        disabled={props.disabled}
      />
    );
  }
  return <Select data={data} value={value} {...props} />;
}

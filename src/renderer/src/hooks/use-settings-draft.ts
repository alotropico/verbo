import {
  useLayoutEffect,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
  type RefObject,
} from "react";
import {
  useForm,
  type FormErrors,
  type UseFormInput,
  type UseFormReturnType,
} from "@mantine/form";
import { useSettingsSession } from "./settings-session-context";
import type { AutosaveController, AutosaveState } from "@/runtime/autosave";

export function useSettingsDraft<Value>(
  key: string,
  initial: Value | (() => Value),
): [Value, Dispatch<SetStateAction<Value>>] {
  const cell = useSettingsSession().cell(key, initial);
  return [
    useSyncExternalStore(cell.subscribe, cell.snapshot, cell.snapshot),
    cell.set,
  ];
}

export function useSettingsRef<Value>(
  key: string,
  initial: Value,
): RefObject<Value> {
  return useSettingsSession().cell(key, () => ({ current: initial })).value;
}

export function useSettingsAutosave<Value>(
  key: string,
  save: (value: Value) => Promise<void>,
  merge?: (previous: Value, next: Value) => Value,
): { controller: AutosaveController<Value>; state: AutosaveState } {
  const entry = useSettingsSession().autosave(key, save, merge);
  const state = useSyncExternalStore(
    entry.state.subscribe,
    entry.state.snapshot,
    entry.state.snapshot,
  );
  useLayoutEffect(() => {
    entry.controller.configure(save, entry.notify, merge);
  }, [entry, save, merge]);
  useLayoutEffect(
    () => () => {
      void entry.controller.flush();
    },
    [entry],
  );
  return { controller: entry.controller, state };
}

export function useSettingsForm<Values extends Record<string, unknown>>(
  key: string,
  options: UseFormInput<Values> & { initialValues: Values },
): UseFormReturnType<Values> {
  const [snapshot, setSnapshot] = useSettingsDraft(key, {
    values: options.initialValues,
    baseline: options.initialValues,
    errors: options.initialErrors ?? ({} as FormErrors),
  });
  const form = useForm<Values>({
    ...options,
    initialValues: snapshot.values,
    initialErrors: snapshot.errors,
    onValuesChange: (values, previous) => {
      setSnapshot((previous) => ({ ...previous, values }));
      options.onValuesChange?.(values, previous);
    },
  });
  const { setInitialValues } = form;
  useLayoutEffect(() => {
    setInitialValues(snapshot.baseline);
  }, [setInitialValues, snapshot.baseline]);
  useLayoutEffect(() => {
    setSnapshot((previous) =>
      previous.errors === form.errors
        ? previous
        : { ...previous, errors: form.errors },
    );
  }, [form.errors, setSnapshot]);
  return form;
}

import { useEffect, useLayoutEffect, useState } from "react";
import { AutosaveController, type AutosaveState } from "@/runtime/autosave";

export function useAutosave<Value>(
  save: (value: Value) => Promise<void>,
  merge?: (previous: Value, next: Value) => Value,
): { controller: AutosaveController<Value>; state: AutosaveState } {
  const [state, setState] = useState<AutosaveState>({
    status: "idle",
    error: "",
  });
  const [controller] = useState(
    () => new AutosaveController<Value>(save, setState, 350, merge),
  );
  useLayoutEffect(() => {
    controller.configure(save, setState, merge);
  }, [controller, save, merge]);
  useEffect(() => {
    const flush = (): void => {
      void controller.flush();
    };
    window.addEventListener("blur", flush);
    return () => {
      controller.detach();
      window.removeEventListener("blur", flush);
      void controller.flush();
    };
  }, [controller]);
  return { controller, state };
}

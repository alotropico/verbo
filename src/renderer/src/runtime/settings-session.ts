import { AutosaveController, type AutosaveState } from "./autosave";

export class SettingsCell<Value> {
  private listeners = new Set<() => void>();
  constructor(public value: Value) {}
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = (): Value => this.value;
  set = (value: Value | ((previous: Value) => Value)): void => {
    const next =
      typeof value === "function"
        ? (value as (previous: Value) => Value)(this.value)
        : value;
    if (Object.is(next, this.value)) return;
    this.value = next;
    for (const listener of this.listeners) listener();
  };
}

type StoredAutosave<Value> = {
  controller: AutosaveController<Value>;
  state: SettingsCell<AutosaveState>;
};

/** Settings data outlives its views; subscriptions exist only for active views. */
export class SettingsSession {
  private cells = new Map<string, unknown>();
  private autosaves = new Map<string, unknown>();

  cell<Value>(
    key: string,
    initial: Value | (() => Value),
  ): SettingsCell<Value> {
    if (!this.cells.has(key)) {
      const value =
        typeof initial === "function" ? (initial as () => Value)() : initial;
      this.cells.set(key, new SettingsCell(value));
    }
    return this.cells.get(key) as SettingsCell<Value>;
  }

  autosave<Value>(
    key: string,
    save: (value: Value) => Promise<void>,
    merge?: (previous: Value, next: Value) => Value,
  ): StoredAutosave<Value> {
    if (!this.autosaves.has(key)) {
      const state = new SettingsCell<AutosaveState>({
        status: "idle",
        error: "",
      });
      const controller = new AutosaveController(save, state.set, 350, merge);
      this.autosaves.set(key, { controller, state });
    }
    return this.autosaves.get(key) as StoredAutosave<Value>;
  }

  async resetAutosaves(prefix: string): Promise<void> {
    for (const [key, record] of this.autosaves)
      if (key.startsWith(prefix))
        await (record as StoredAutosave<unknown>).controller.reset();
  }

  clear(prefix: string): void {
    for (const key of this.cells.keys())
      if (key.startsWith(prefix)) this.cells.delete(key);
    for (const key of this.autosaves.keys())
      if (key.startsWith(prefix)) this.autosaves.delete(key);
  }

  async flush(): Promise<void> {
    await Promise.all(
      [...this.autosaves.values()].map((record) =>
        (record as StoredAutosave<unknown>).controller.flush(),
      ),
    );
  }
}

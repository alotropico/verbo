export type SettingsResourceState<Value> = {
  data: Value | null;
  loading: boolean;
  error: string;
};

/** Short-lived presentation data only; inactive views neither poll nor refetch. */
export class SettingsResource<Value> {
  private state: SettingsResourceState<Value> = { data: null, loading: true, error: "" };
  private listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private expires = 0;
  private refreshRequested = false;

  constructor(
    private loader: () => Promise<Value>,
    private ttl = 30_000,
  ) {}

  configure(loader: () => Promise<Value>): void {
    this.loader = loader;
  }
  snapshot = (): SettingsResourceState<Value> => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: SettingsResourceState<Value>): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  invalidate(): void {
    this.expires = 0;
    if (this.running) this.refreshRequested = true;
    if (this.listeners.size) void this.reload();
  }
  reload = (): Promise<void> => {
    this.expires = 0;
    if (this.running) this.refreshRequested = true;
    return this.load();
  };
  load = (): Promise<void> => {
    if (this.running) return this.running;
    if (this.state.data !== null && Date.now() < this.expires) return Promise.resolve();
    this.running = this.read().finally(() => {
      this.running = null;
    });
    return this.running;
  };
  private async read(): Promise<void> {
    do {
      this.refreshRequested = false;
      this.publish({ ...this.state, loading: true, error: "" });
      try {
        const data = await this.loader();
        if (!this.refreshRequested) {
          this.expires = Date.now() + this.ttl;
          this.publish({ data, loading: false, error: "" });
        }
      } catch (cause) {
        if (!this.refreshRequested)
          this.publish({ ...this.state, loading: false, error: cause instanceof Error ? cause.message : "Settings could not be loaded." });
      }
    } while (this.refreshRequested);
  }
}

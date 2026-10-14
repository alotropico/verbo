export type AutosaveState = {
  status: "idle" | "saving" | "saved" | "error";
  error: string;
};

/** Coalesces drafts and serializes persistence; a failed older write never replaces a newer draft. */
export class AutosaveController<Value> {
  private pending: { value: Value; revision: number } | null = null;
  private failed: Value | null = null;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private revision = 0;

  constructor(
    private save: (value: Value) => Promise<void>,
    private notify: (state: AutosaveState) => void,
    private delay = 350,
    private merge?: (previous: Value, next: Value) => Value,
  ) {}

  configure(
    save: (value: Value) => Promise<void>,
    notify: (state: AutosaveState) => void,
    merge?: (previous: Value, next: Value) => Value,
  ): void {
    this.save = save;
    this.notify = notify;
    this.merge = merge;
  }

  detach(): void {
    this.notify = () => undefined;
  }

  schedule(value: Value): void {
    const previous = this.pending?.value ?? this.failed;
    this.pending = {
      value:
        previous !== null && this.merge ? this.merge(previous, value) : value,
      revision: ++this.revision,
    };
    this.failed = null;
    this.notify({ status: "saving", error: "" });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delay);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) {
      await this.running;
      if (this.pending) await this.flush();
      return;
    }
    this.running = this.drain();
    await this.running;
    this.running = null;
    if (this.pending) await this.flush();
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      const request = this.pending;
      this.pending = null;
      try {
        await this.save(request.value);
        if (request.revision === this.revision) {
          this.failed = null;
          this.notify({ status: "saved", error: "" });
        }
      } catch (cause) {
        this.mergeFailedFields(request.value);
        if (request.revision === this.revision) {
          this.failed = request.value;
          this.notify({
            status: "error",
            error:
              cause instanceof Error
                ? cause.message
                : "Could not save changes.",
          });
        }
      }
    }
  }

  private mergeFailedFields(value: Value): void {
    if (this.pending && this.merge)
      this.pending.value = this.merge(value, this.pending.value);
  }

  retry(): void {
    if (this.failed !== null) this.schedule(this.failed);
  }
  async reset(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.failed = null;
    ++this.revision;
    if (this.running) await this.running;
    this.notify({ status: "idle", error: "" });
  }
}

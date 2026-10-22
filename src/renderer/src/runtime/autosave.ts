export type AutosaveState = {
  status: "idle" | "saving" | "saved" | "error";
  error: string;
};

export const SETTINGS_SAVE_DELAY = 1000;
export const LONG_TEXT_SAVE_DELAY = 1500;

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equal(value, right[index]))
    );
  const previous = left as Record<string, unknown>;
  const next = right as Record<string, unknown>;
  const keys = Object.keys(previous);
  return keys.length === Object.keys(next).length && keys.every((key) => Object.hasOwn(next, key) && equal(previous[key], next[key]));
}

/** Coalesces drafts and serializes persistence; a failed older write never replaces a newer draft. */
export class AutosaveController<Value> {
  private pending: { value: Value; revision: number } | null = null;
  private failed: Value | null = null;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private revision = 0;
  private readyRevision = 0;
  private committed: { value: Value } | null = null;

  constructor(
    private save: (value: Value) => Promise<void>,
    private notify: (state: AutosaveState) => void,
    private delay = SETTINGS_SAVE_DELAY,
    private merge?: (previous: Value, next: Value) => Value,
  ) {}

  baseline(value: Value): void {
    if (!this.committed && !this.revision) this.committed = { value };
  }

  acceptBaseline(value: Value): void {
    if (!this.pending && !this.running && this.failed === null) this.committed = { value };
  }

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

  schedule(value: Value, delay = this.delay): void {
    const previous = this.pending?.value ?? this.failed;
    const next = previous !== null && this.merge ? this.merge(previous, value) : value;
    if (this.pending && equal(this.pending.value, next)) return;
    if (!this.running && this.failed === null && this.committed) {
      const updated = this.merge ? this.merge(this.committed.value, next) : next;
      if (equal(updated, this.committed.value)) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.pending = null;
        ++this.revision;
        this.notify({ status: "idle", error: "" });
        return;
      }
    }
    this.pending = { value: next, revision: ++this.revision };
    this.failed = null;
    this.notify({ status: "saving", error: "" });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.readyRevision = this.revision;
      void this.persistReady();
    }, delay);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.readyRevision = this.revision;
    await this.persistReady();
  }

  private async persistReady(): Promise<void> {
    if (this.running) await this.running;
    if (this.running || !this.pending || this.pending.revision > this.readyRevision) return;
    this.running = this.drain();
    await this.running;
    this.running = null;
  }

  private async drain(): Promise<void> {
    while (this.pending && this.pending.revision <= this.readyRevision) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      const request = this.pending;
      this.pending = null;
      try {
        await this.save(request.value);
        this.committed = { value: this.committed && this.merge ? this.merge(this.committed.value, request.value) : request.value };
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
            error: cause instanceof Error ? cause.message : "Could not save changes.",
          });
        }
      }
    }
  }

  private mergeFailedFields(value: Value): void {
    if (this.pending && this.merge) this.pending.value = this.merge(value, this.pending.value);
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

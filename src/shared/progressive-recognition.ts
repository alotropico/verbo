import { MAX_VOICE_AUDIO_BYTES, type VoiceTextResult } from "./voice";
import { MAX_VOICE_SEGMENT_CHARS } from "./voice-draft";

export type RecognitionSnapshot = {
  id: string;
  sequence: number;
  final: boolean;
  audio: Uint8Array;
};
/** Serial recognition coalesces cumulative audio prefixes; only a final snapshot commits. */
export class ProgressiveRecognition {
  private queued: RecognitionSnapshot[] = [];
  private busy = false;
  private generation = 0;
  private activeGeneration: number | null = null;
  private completed = new Set<string>();
  private latest = new Map<string, number>();
  constructor(
    private callbacks: {
      transcribe: (audio: Uint8Array) => Promise<VoiceTextResult>;
      preview: (id: string, text: string) => void;
      commit: (id: string, text: string) => Promise<void>;
      error: (message: string) => void;
      pending: (pending: boolean) => void;
      settled?: (id: string) => void;
    },
  ) {}
  get pending(): boolean {
    return this.queued.length > 0 || this.activeGeneration === this.generation;
  }
  enqueue(snapshot: RecognitionSnapshot): void {
    if (this.completed.has(snapshot.id)) {
      if (snapshot.final) this.callbacks.pending(this.pending);
      return;
    }
    if ((this.latest.get(snapshot.id) ?? -1) >= snapshot.sequence) return;
    if (
      !snapshot.audio.byteLength ||
      snapshot.audio.byteLength > MAX_VOICE_AUDIO_BYTES
    ) {
      this.callbacks.error("Recorded audio exceeded its limit.");
      this.discard(snapshot.id);
      return;
    }
    this.latest.set(snapshot.id, snapshot.sequence);
    this.queued = this.queued.filter(
      (item) => item.id !== snapshot.id || item.final,
    );
    if (this.queued.some((item) => item.id === snapshot.id && item.final))
      return;
    if (this.queued.length >= 4) {
      this.callbacks.error(
        "Recognition is behind. Stop speaking until it settles.",
      );
      this.discard(snapshot.id);
      return;
    }
    this.queued.push(snapshot);
    this.callbacks.pending(true);
    void this.drain();
  }
  discard(id: string): void {
    const first = !this.completed.has(id);
    this.completed.add(id);
    this.queued = this.queued.filter((item) => item.id !== id);
    if (first) this.callbacks.settled?.(id);
    this.pruneCompleted();
    this.callbacks.pending(this.pending);
  }
  private pruneCompleted(): void {
    while (this.completed.size > 64) {
      const oldest = this.completed.values().next().value;
      if (!oldest) break;
      this.completed.delete(oldest);
      this.latest.delete(oldest);
    }
  }
  stop(): void {
    this.generation += 1;
    this.queued = [];
    this.completed.clear();
    this.latest.clear();
    this.callbacks.pending(false);
  }
  private async drain(): Promise<void> {
    if (this.busy) return;
    const snapshot = this.queued.shift();
    if (!snapshot) return;
    this.busy = true;
    const generation = this.generation;
    this.activeGeneration = generation;
    try {
      const result = await this.callbacks.transcribe(snapshot.audio);
      if (generation !== this.generation || this.completed.has(snapshot.id))
        return;
      if (!result.ok) {
        // Incomplete WebM prefixes may be undecodable; final audio still gets a chance.
        if (snapshot.final && result.code !== "cancelled")
          this.callbacks.error(result.detail);
      } else {
        const text = result.text.trim();
        if (text.length > MAX_VOICE_SEGMENT_CHARS) {
          if (snapshot.final)
            this.callbacks.error(
              "The recognized segment exceeds the text limit. It was not submitted.",
            );
          return;
        }
        if (snapshot.final) {
          this.completed.add(snapshot.id);
          if (text) await this.callbacks.commit(snapshot.id, text);
        } else if (text) this.callbacks.preview(snapshot.id, text);
      }
      if (snapshot.final) this.completed.add(snapshot.id);
    } catch {
      if (generation === this.generation && snapshot.final)
        this.callbacks.error("Transcription failed. Typed chat still works.");
    } finally {
      if (generation === this.generation && snapshot.final)
        this.callbacks.settled?.(snapshot.id);
      this.busy = false;
      this.activeGeneration = null;
      this.pruneCompleted();
      this.callbacks.pending(this.pending);
      void this.drain();
    }
  }
}

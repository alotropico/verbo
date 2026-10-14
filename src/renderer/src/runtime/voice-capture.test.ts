import { afterEach, describe, expect, it, vi } from "vitest";
import { startVoiceCapture } from "./voice-capture";
import type { RecognitionSnapshot } from "../../../shared/progressive-recognition";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("cumulative capture snapshots", () => {
  it("includes the initial container header in every prefix and retains a separate final snapshot", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let rms = 0.1;
    const snapshots: RecognitionSnapshot[] = [];
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] };
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => stream },
    });
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        createMediaStreamSource(): { connect: () => void } {
          return { connect: () => {} };
        }
        createAnalyser(): {
          fftSize: number;
          getFloatTimeDomainData: (values: Float32Array) => void;
        } {
          return {
            fftSize: 2048,
            getFloatTimeDomainData: (values) => values.fill(rms),
          };
        }
      async close(): Promise<void> { /* The mock has no device resources. */ }
      },
    );
    class FakeRecorder {
      static instance: FakeRecorder;
      static isTypeSupported(): boolean {
        return true;
      }
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor() {
        FakeRecorder.instance = this;
      }
      start(): void {
        this.state = "recording";
      }
      emit(text: string): void {
        this.ondataavailable?.({ data: new Blob([text]) });
      }
      stop(): void {
        this.state = "inactive";
        this.emit("-final");
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const capture = await startVoiceCapture({
      paused: () => false,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onSegment: () => {
        throw new Error(
          "Bare segments must not be used with progressive snapshots.",
        );
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    FakeRecorder.instance.emit("header");
    await vi.advanceTimersByTimeAsync(2100);
    FakeRecorder.instance.emit("-cluster");
    // Blob.arrayBuffer uses a native async operation, independent of fake timers.
    await vi.waitFor(() => expect(snapshots).toHaveLength(1));
    expect(new TextDecoder().decode(snapshots[0]!.audio)).toBe(
      "header-cluster",
    );
    rms = 0;
    await vi.advanceTimersByTimeAsync(800);
    await vi.waitFor(() => expect(snapshots).toHaveLength(2));
    expect(new TextDecoder().decode(snapshots[1]!.audio)).toBe(
      "header-cluster-final",
    );
    expect(snapshots[1]!.final).toBe(true);
    expect(snapshots[1]!.id).toBe(snapshots[0]!.id);
    capture.stop();
    expect(stopTrack).toHaveBeenCalledOnce();
  });
});

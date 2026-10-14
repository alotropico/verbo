import {
  idleLevelClock,
  signalRms,
  DEFAULT_LEVEL_LIMITS,
  stepLevel,
  type LevelClock,
  type LevelLimits,
} from "@shared/voice-audio";
import { MAX_VOICE_AUDIO_BYTES } from "@shared/voice";
import type { RecognitionSnapshot } from "@shared/progressive-recognition";

export type VoiceCapture = {
  stop: () => void;
};

function captureError(error: unknown): Error {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new Error(
      "Microphone permission was denied. Typed chat still works.",
    );
  }
  if (name === "NotFoundError") {
    return new Error("No microphone was found. Typed chat still works.");
  }
  return new Error("Microphone capture failed. Typed chat still works.");
}

export async function startVoiceCapture(input: {
  paused: () => boolean;
  onSpeechStart?: (id: string) => void;
  onSpeechEnd?: (emitted: boolean, id: string) => void;
  onSegmentSkipped?: (id: string) => void;
  onSegment: (audio: Uint8Array) => void;
  onSnapshot?: (snapshot: RecognitionSnapshot) => void;
  limits?: () => LevelLimits;
}): Promise<VoiceCapture> {
  if (
    typeof MediaRecorder === "undefined" ||
    !navigator.mediaDevices?.getUserMedia
  ) {
    throw new Error(
      "Microphone capture is unavailable. Typed chat still works.",
    );
  }
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    throw new Error(
      "This browser cannot record audio. Typed chat still works.",
    );
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
  } catch (error) {
    throw captureError(error);
  }
  const context = new AudioContext();
  try {
    if (context.state === "suspended") await context.resume();
  } catch {
    for (const track of stream.getTracks()) track.stop();
    void context.close();
    throw new Error("Microphone capture failed. Typed chat still works.");
  }
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let clock: LevelClock = idleLevelClock();
  let recorder: MediaRecorder | null = null;
  let current: { id: string; emit: boolean } | null = null;
  let stopped = false;
  let timer = 0;
  let last = performance.now();

  const stopRecorder = (shouldEmit: boolean): void => {
    if (current) current.emit = shouldEmit;
    if (recorder?.state === "recording") recorder.stop();
  };

  const startRecorder = (): void => {
    if (recorder?.state === "recording") return;
    const segment = { id: crypto.randomUUID(), emit: false };
    current = segment;
    input.onSpeechStart?.(segment.id);
    const chunks: Blob[] = [];
    let bytes = 0;
    let sequence = 0;
    let snapshotAt = performance.now();
    const next = new MediaRecorder(stream, { mimeType });
    next.ondataavailable = (event) => {
      if (event.data.size <= 0) return;
      bytes += event.data.size;
      if (bytes > MAX_VOICE_AUDIO_BYTES) {
        segment.emit = false;
        if (next.state === "recording") next.stop();
        return;
      }
      chunks.push(event.data);
      if (
        input.onSnapshot &&
        next.state === "recording" &&
        performance.now() - snapshotAt >= 2000
      ) {
        snapshotAt = performance.now();
        const seq = ++sequence;
        // Always include the initial WebM header and every earlier chunk, never decode a bare timeslice.
        void new Blob(chunks, { type: mimeType })
          .arrayBuffer()
          .then((buffer) => {
            if (!stopped && next.state === "recording")
              input.onSnapshot?.({
                id: segment.id,
                sequence: seq,
                final: false,
                audio: new Uint8Array(buffer),
              });
          })
          .catch(() => undefined);
      }
    };
    next.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      if (
        !segment.emit ||
        blob.size === 0 ||
        stopped ||
        bytes > MAX_VOICE_AUDIO_BYTES
      ) {
        input.onSegmentSkipped?.(segment.id);
        return;
      }
      void blob
        .arrayBuffer()
        .then((buffer) => {
          if (stopped) return;
          const audio = new Uint8Array(buffer);
          if (input.onSnapshot)
            input.onSnapshot({
              id: segment.id,
              sequence: ++sequence,
              final: true,
              audio,
            });
          else input.onSegment(audio);
        })
        .catch(() => input.onSegmentSkipped?.(segment.id));
    };
    recorder = next;
    next.start(1000);
  };

  const tick = (): void => {
    if (stopped) return;
    const now = performance.now();
    const deltaMs = Math.min(200, Math.max(0, now - last));
    last = now;
    analyser.getFloatTimeDomainData(samples);
    const step = stepLevel(
      clock,
      {
        rms: signalRms(samples),
        deltaMs,
        paused: input.paused(),
      },
      input.limits?.() ?? DEFAULT_LEVEL_LIMITS,
    );
    clock = step.clock;
    if (step.start) {
      startRecorder();
    }
    if (step.finish) {
      const emitted = step.finish === "emit";
      input.onSpeechEnd?.(emitted, current?.id ?? "");
      stopRecorder(emitted);
    }
    timer = window.setTimeout(tick, 100);
  };
  timer = window.setTimeout(tick, 100);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      window.clearTimeout(timer);
      try {
        stopRecorder(false);
      } finally {
        for (const track of stream.getTracks()) track.stop();
        void context.close();
      }
    },
  };
}

export const SPEECH_RMS_THRESHOLD = 0.02;
export const SILENCE_HOLD_MS = 700;
export const MIN_SPEECH_MS = 300;
export const MAX_SEGMENT_MS = 20_000;

export type LevelLimits = {
  speechRms: number;
  silenceHoldMs: number;
  minSpeechMs: number;
  maxSegmentMs: number;
};

export const DEFAULT_LEVEL_LIMITS: LevelLimits = {
  speechRms: SPEECH_RMS_THRESHOLD,
  silenceHoldMs: SILENCE_HOLD_MS,
  minSpeechMs: MIN_SPEECH_MS,
  maxSegmentMs: MAX_SEGMENT_MS,
};

export type LevelClock = {
  speaking: boolean;
  speechMs: number;
  silenceMs: number;
  elapsedMs: number;
};

export function idleLevelClock(): LevelClock {
  return { speaking: false, speechMs: 0, silenceMs: 0, elapsedMs: 0 };
}

export function signalRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

export function stepLevel(
  clock: LevelClock,
  input: { rms: number; deltaMs: number; paused: boolean },
  limits: LevelLimits = DEFAULT_LEVEL_LIMITS,
): { clock: LevelClock; start: boolean; finish: "emit" | "discard" | null } {
  const quiet = idleLevelClock();
  if (input.paused) {
    if (!clock.speaking) return { clock, start: false, finish: null };
    return { clock: quiet, start: false, finish: "discard" };
  }
  const loud = input.rms >= limits.speechRms;
  if (!clock.speaking) {
    if (!loud) return { clock, start: false, finish: null };
    return {
      clock: {
        speaking: true,
        speechMs: input.deltaMs,
        silenceMs: 0,
        elapsedMs: input.deltaMs,
      },
      start: true,
      finish: null,
    };
  }
  const speechMs = clock.speechMs + (loud ? input.deltaMs : 0);
  const silenceMs = loud ? 0 : clock.silenceMs + input.deltaMs;
  const elapsedMs = clock.elapsedMs + input.deltaMs;
  if (elapsedMs >= limits.maxSegmentMs) {
    return {
      clock: quiet,
      start: false,
      finish: speechMs >= limits.minSpeechMs ? "emit" : "discard",
    };
  }
  if (!loud && silenceMs >= limits.silenceHoldMs) {
    return {
      clock: quiet,
      start: false,
      finish: speechMs >= limits.minSpeechMs ? "emit" : "discard",
    };
  }
  return {
    clock: { speaking: true, speechMs, silenceMs, elapsedMs },
    start: false,
    finish: null,
  };
}

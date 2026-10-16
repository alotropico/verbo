/** A short, quiet sine tone with soft edges to avoid clicks. */
export async function playReplyNotification(): Promise<void> {
  let context: AudioContext | undefined;
  try {
    context = new AudioContext();
    await context.resume();
    const tone = context.createOscillator();
    const volume = context.createGain();
    const start = context.currentTime;
    tone.type = "sine";
    tone.frequency.setValueAtTime(660, start);
    volume.gain.setValueAtTime(0, start);
    volume.gain.linearRampToValueAtTime(0.025, start + 0.015);
    volume.gain.exponentialRampToValueAtTime(0.001, start + 0.16);
    volume.gain.linearRampToValueAtTime(0, start + 0.18);
    tone.connect(volume);
    volume.connect(context.destination);
    const audio = context;
    tone.onended = () => {
      void audio.close().catch(() => {});
    };
    tone.start(start);
    tone.stop(start + 0.18);
  } catch {
    // Audio can be unavailable; the taskbar still signals the reply.
    await context?.close().catch(() => {});
  }
}

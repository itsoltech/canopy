let context: AudioContext | undefined;

/** Called by the user's permission gesture, so later alerts may play without a new gesture. */
export async function enableNotificationSound(): Promise<void> {
  context ??= new AudioContext();

  if (context.state !== "running") await context.resume();
}

/** Browsers require a fresh user gesture after reload, even for a persisted sound preference. */
export function connectNotificationSound(enabled: () => boolean): () => void {
  const resume = () => {
    if (enabled()) void enableNotificationSound().catch(() => undefined);
  };

  window.addEventListener("pointerdown", resume);
  window.addEventListener("keydown", resume);

  return () => {
    window.removeEventListener("pointerdown", resume);
    window.removeEventListener("keydown", resume);
  };
}

export function playNotificationSound(): void {
  if (!context || context.state !== "running") return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = 660;
  gain.gain.setValueAtTime(0.08, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.18);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.2);
}

import type { ui } from "@canopy/contracts";

/** Shared update-check policy and labels. Zero means manual checks only. */
export const updateCheckChoices = [
  { value: "60", label: "Every hour" },
  { value: "360", label: "Every 6 hours" },
  { value: "1440", label: "Daily" },
  { value: "10080", label: "Weekly" },
  { value: "0", label: "Never (manual only)" },
] as const;

export function isCheckInterval(value: number): boolean {
  return updateCheckChoices.some((choice) => Number(choice.value) === value);
}

export function nextUpdateCheck(lastChecked: number, minutes: number, now: number): number | undefined {
  if (minutes === 0) return undefined;

  return lastChecked ? lastChecked + minutes * 60_000 : now;
}

/** Injectable clock/timer makes the policy verifiable without waiting for real hours. */
export interface CheckClock {
  now(): number;
  schedule(run: () => void, delay: number): () => void;
}

export const systemCheckClock: CheckClock = {
  now: Date.now,
  schedule: (run, delay) => {
    const timer = setTimeout(run, delay);

    return () => clearTimeout(timer);
  },
};

export class UpdateCheckTimer {
  #cancel: (() => void) | undefined;
  #generation = 0;
  constructor(readonly clock: CheckClock = systemCheckClock) {}

  start(minutes: number, lastChecked: number, run: () => Promise<void>): void {
    this.stop();
    const generation = this.#generation;
    const next = nextUpdateCheck(lastChecked, minutes, this.clock.now());

    if (next === undefined) return;
    this.#cancel = this.clock.schedule(
      () => {
        const checkedAt = this.clock.now();
        void run().finally(() => {
          if (generation === this.#generation) this.start(minutes, checkedAt, run);
        });
      },
      Math.max(0, next - this.clock.now()),
    );
  }

  stop(): void {
    this.#generation++;
    this.#cancel?.();
    this.#cancel = undefined;
  }
}

/** What the update center shows of a worker: presence, versions and CLI updates (not its running turns). */
export const workerUpdateSignature = (worker: ui.Worker) =>
  `${worker.online}:${worker.version}:${worker.cliTools
    .map((t) => `${t.tool?.provider}:${t.tool?.version}:${t.updateAvailable}:${t.action}`)
    .join(",")}`;

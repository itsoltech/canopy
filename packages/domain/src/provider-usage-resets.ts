import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { ProviderUsageWindow } from "@canopy/contracts";
import { codexQuotaPeriod, isUsageResetPlausible, usageWindowName } from "./provider-usage.ts";

export type ResetProvider = "claude" | "codex";

export interface UsageResetReading {
  readonly source: string;
  readonly window: ProviderUsageWindow;
  readonly observedAt: number;
  readonly accountKey?: string;
  readonly canConfirm?: boolean;
  readonly passive?: boolean;
}

interface ReachedWindow {
  readonly resetAt: number;
  readonly observedAt: number;
}

interface ResetNotice {
  readonly key: string;
  readonly label: string;
}

const claudeWindows = new Set([
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
]);

const historyMs = 10 * 60_000;

export class UsageResets {
  #reached = new Map<string, ReachedWindow>();
  #observed = new Map<string, number>();
  #notified = new Map<string, number>();

  constructor(
    readonly provider: ResetProvider,
    readonly startedAt = 0,
  ) {}

  observe(readings: Iterable<UsageResetReading>, now = Date.now()): ResetNotice[] {
    const reached = new Map<string, ReachedWindow>();
    const observed = new Map<string, number>();
    const notices = new Map<string, ResetNotice>();

    for (const reading of readings) {
      const { source, window, observedAt } = reading;

      if (!Number.isFinite(observedAt) || !this.#supported(reading)) continue;
      const codex = this.provider === "codex";
      const duration = codex ? window.windowMinutes : 0;
      const identity = `${source}:${window.key}:${duration}`;
      const before = this.#reached.get(identity);
      const previousAt = this.#observed.get(identity);

      if (codex) {
        if (observedAt > now) {
          if (previousAt !== undefined) observed.set(identity, previousAt);

          if (before && now - before.resetAt <= historyMs) reached.set(identity, before);
          continue;
        }

        observed.set(identity, Math.max(previousAt ?? 0, observedAt));

        if (observedAt <= this.startedAt || (reading.passive && previousAt === undefined)) continue;
      }

      if (observedAt <= (previousAt ?? 0) || (before && observedAt <= before.observedAt)) {
        if (before && now - before.resetAt <= historyMs) reached.set(identity, before);
        continue;
      }

      const resetAt = window.resetsAt && timestampDate(window.resetsAt).getTime();

      if (codex && resetAt !== undefined && resetAt - observedAt > duration * 60_000) continue;

      if (window.reached || (window.usedPercent ?? 0) >= 100) {
        if (
          resetAt !== undefined &&
          isUsageResetPlausible(resetAt, now) &&
          (resetAt > Math.max(now, observedAt) || (resetAt === before?.resetAt && now - resetAt <= historyMs))
        )
          reached.set(identity, { resetAt, observedAt });
        continue;
      }

      if (!before || observedAt < before.resetAt || now < before.resetAt || now - before.resetAt > historyMs) continue;

      if (!this.#confirmed(reading, before, resetAt, now)) {
        if (codex) reached.set(identity, before);
        continue;
      }

      const period = window.key.replaceAll("_", "-");
      const renewal = Math.floor(before.resetAt / 1000);

      const key = codex
        ? `codex:${reading.accountKey}:${period}:${duration}:${renewal}`
        : `claude:${period}:${renewal}`;

      if (codex && this.#notified.has(key)) continue;

      if (codex) this.#notified.set(key, before.resetAt);
      notices.set(key, { key, label: `${usageWindowName(window.key, duration)} limit` });
    }

    this.#reached = reached;
    this.#observed = observed;

    for (const [key, resetAt] of this.#notified) if (now - resetAt > historyMs) this.#notified.delete(key);

    return [...notices.values()];
  }

  #supported({ window, accountKey }: UsageResetReading): boolean {
    if (this.provider === "claude") return claudeWindows.has(window.key);

    return Boolean(
      accountKey && /^[a-f0-9]{64}$/.test(accountKey) && codexQuotaPeriod(window.windowMinutes) === window.key,
    );
  }

  #confirmed(
    { window, observedAt, canConfirm }: UsageResetReading,
    before: ReachedWindow,
    resetAt: number | undefined,
    now: number,
  ): boolean {
    if (this.provider === "codex" && (!canConfirm || window.usedPercent === undefined || resetAt === undefined))
      return false;

    // An idle Claude rolling window can report an explicit zero and no next deadline.
    return resetAt === undefined
      ? window.usedPercent === 0
      : resetAt > Math.max(before.resetAt, observedAt) && isUsageResetPlausible(resetAt, now);
  }
}

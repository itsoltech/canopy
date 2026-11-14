import type { ui } from "@canopy/contracts";
import type { BucketBudget } from "./buckets.ts";

/** Closed labels only. Lifetime counters remain separate from selected-window loss. */
export const LIMIT_REASONS = [
  "memory",
  "sql_buffer",
  "correlations",
  "coverage",
  "history",
  "collection",
  "persistence",
] as const;

export type LimitReason = (typeof LIMIT_REASONS)[number];

const MINUTES = 1441;

export class DiagnosticsLosses {
  readonly #times = new Float64Array(MINUTES).fill(-1);
  readonly #counts = new Float64Array(MINUTES * LIMIT_REASONS.length);

  add(reason: LimitReason, at: number, count: number) {
    const minute = Math.floor(at / 60_000);
    const index = ((minute % MINUTES) + MINUTES) % MINUTES;
    const offset = index * LIMIT_REASONS.length;

    if (this.#times[index]! > minute) return;

    if (this.#times[index] !== minute) {
      this.#counts.fill(0, offset, offset + LIMIT_REASONS.length);
      this.#times[index] = minute;
    }

    this.#counts[offset + LIMIT_REASONS.indexOf(reason)]! += count;
  }

  between(start: number, end: number) {
    let count = 0;
    const reasons = new Set<LimitReason>();

    for (let index = 0; index < MINUTES; index++) {
      const at = this.#times[index]! * 60_000;

      if (at < Math.floor(start / 60_000) * 60_000 || at > end) continue;

      for (const [reason, name] of LIMIT_REASONS.entries()) {
        const value = this.#counts[index * LIMIT_REASONS.length + reason]!;
        count += value;

        if (value) reasons.add(name);
      }
    }

    return { count, reasons: [...reasons] };
  }
}

export function snapshotLimits(
  own: Pick<ui.ComputerDiagnostics, "windowStartMs" | "windowEndMs" | "droppedSamples" | "limitReasons">,
  links: BucketBudget,
  missingLinks: number,
  historyDrops: number,
) {
  const losses = links.losses(Number(own.windowStartMs), Number(own.windowEndMs));

  return {
    droppedSamples: own.droppedSamples + BigInt(losses.count + missingLinks + historyDrops),
    limitReasons: [
      ...new Set([
        ...own.limitReasons,
        ...losses.reasons,
        ...(missingLinks ? ["links"] : []),
        ...(historyDrops ? ["history"] : []),
      ]),
    ],
  };
}

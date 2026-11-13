export interface PairedDelta {
  pair: number;
  phase: string;
  metric: string;
  delta: number;
}

export interface PairSwap {
  pair: number;
  peakSwapOutKiBPerSec: number;
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Whole-pair sensitivity analysis; flags never alter acceptance or the primary median. */
export function pairedSummary(deltas: readonly PairedDelta[], swaps: readonly PairSwap[]) {
  const groups = new Map<string, PairedDelta[]>();

  for (const delta of deltas) {
    const key = `${delta.phase}/${delta.metric}`;
    const group = groups.get(key) ?? [];
    group.push(delta);
    groups.set(key, group);
  }

  const flags: (PairedDelta & { median: number; mad: number; peakSwapOutKiBPerSec: number })[] = [];

  for (const group of groups.values()) {
    const center = median(group.map((row) => row.delta))!;
    const mad = median(group.map((row) => Math.abs(row.delta - center)))!;

    for (const row of group) {
      const swap = swaps.find((swap) => swap.pair === row.pair);

      if (!swap) throw new Error("Missing accepted pair swap counters");

      if (Math.abs(row.delta - center) > 2 * mad && swap.peakSwapOutKiBPerSec > 4096)
        flags.push({ ...row, median: center, mad, peakSwapOutKiBPerSec: swap.peakSwapOutKiBPerSec });
    }
  }

  const flaggedPairs = [...new Set(flags.map((row) => row.pair))].sort((a, b) => a - b);

  const medians = [...groups.values()].map((group) => {
    const remaining = group.filter((row) => !flaggedPairs.includes(row.pair));

    return {
      phase: group[0]!.phase,
      metric: group[0]!.metric,
      n: group.length,
      all: median(group.map((row) => row.delta)),
      unflaggedN: remaining.length,
      unflagged: median(remaining.map((row) => row.delta)),
    };
  });

  return { flaggedPairs, flags, medians };
}

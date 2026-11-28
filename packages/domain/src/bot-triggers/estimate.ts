import type { TriggerFilter } from "./filter.ts";

const HOUR = 3_600_000;

const DAY = 24 * HOUR;

/** A batch closes at this many events before its quiet window ends (as in the gateway). */
const BATCH_MAX = 20;

export interface RunEstimate {
  matched: number;
  runs: number;
  /** The most runs in any 24 hours of the sample. */
  busiestDay: number;
}

/**
 * Replays matched event times (milliseconds) as the gateway runs them: a batch opens with an event and closes after
 * its quiet window or at its size limit. Over the hourly limit it stays open, taking in new events, until a slot is
 * free, and then runs once.
 */
export function estimateRuns(
  times: readonly number[],
  filter: Pick<TriggerFilter, "coalesce_seconds" | "max_turns_per_hour">,
): RunEstimate {
  const sorted = [...times].sort((a, b) => a - b);
  const runs: number[] = [];
  const limit = filter.max_turns_per_hour;
  let next = 0;

  while (next < sorted.length) {
    let due = sorted[next]! + filter.coalesce_seconds * 1000;
    let size = 0;

    while (next < sorted.length && sorted[next]! <= due && size < BATCH_MAX) {
      size += 1;

      if (size === BATCH_MAX) due = sorted[next]!;
      next += 1;
    }

    const recent = runs.filter((r) => r > due - HOUR);
    const at = recent.length >= limit ? Math.max(due, recent[recent.length - limit]! + HOUR) : due;

    while (next < sorted.length && sorted[next]! <= at) next += 1;
    runs.push(at);
  }

  const busiestDay = runs.reduce(
    (most, start) => Math.max(most, runs.filter((r) => r >= start && r < start + DAY).length),
    0,
  );

  return { matched: sorted.length, runs: runs.length, busiestDay };
}

import type { ui } from "@canopy/contracts";
import type { FeedRow } from "./feed.ts";
import type { TimelineEntry } from "./thread-types.ts";
import type { FoldedRow } from "./work-groups.ts";
import type { TimelineRow } from "./timeline.ts";

/** Independent item windows must not present an unloaded turn as completed, empty work. */
export function workHistoryGaps(
  turns: readonly ui.Turn[],
  entries: readonly TimelineEntry[],
  hasMore: boolean,
): ReadonlySet<string> {
  if (!hasMore) return new Set();
  const present = new Set(entries.map((entry) => entry.turnId));

  const first = entries.reduce<TimelineEntry | undefined>(
    (oldest, entry) => (!oldest || entry.firstSeq < oldest.firstSeq ? entry : oldest),
    undefined,
  );

  // The first loaded item can be halfway through a turn, including between steer segments.
  return new Set(
    turns.flatMap((turn) =>
      !turn.withdrawn && turn.status !== "queued" && (!present.has(turn.id) || turn.id === first?.turnId)
        ? [turn.id]
        : [],
    ),
  );
}

/** Fetch before the reader reaches missing work, using the virtualizer's mounted overscan window. */
export function prefetchWorkHistory(rows: readonly FeedRow[], start: number, end: number): boolean {
  return rows.slice(start, end).some((row) => row.kind === "work-gap");
}

/** Every source row must belong to shown input/answer content or a fold summary. Fail open on disagreement. */
export function recoverFoldRows(
  body: readonly TimelineRow[],
  folded: FoldedRow[],
  report: (count: number) => void,
): FoldedRow[] {
  const covered = folded.reduce(
    (count, row) =>
      count +
      (row.kind === "work"
        ? row.summary.size
        : row.kind === "answer"
          ? Number(Boolean(row.row))
          : row.kind === "row" && !row.work
            ? 1
            : 0),
    0,
  );

  if (covered === body.length) return folded;
  report(body.length);

  return body.map((row) => ({ kind: "row", row, work: false }));
}

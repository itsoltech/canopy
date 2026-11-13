/** When a turn's "Working for …" fold is open (web and mobile timelines, docs/timeline-folding.md). */
export interface WorkFoldPreferences {
  readonly expandWhileWorking: boolean;
  readonly keepAfterTurn: boolean;
}

/** Durable boundary of a segment: a final answer is identified by its transcript sequence. */
export interface WorkFoldState {
  readonly live: boolean;
  readonly answered: boolean;
  readonly answerSeq: bigint | undefined;
}

/** A choice belongs to the boundary at which the reader made it, never to a transient UI event. */
export interface WorkFoldChoice {
  readonly open: boolean;
  readonly state: WorkFoldState;
}

/** Live choices expire at the final answer or end; choices made after the end survive late items. */
export function workFoldOpen(state: WorkFoldState, preferences: WorkFoldPreferences, manual?: WorkFoldChoice): boolean {
  if (
    manual &&
    manual.state.live === state.live &&
    (!state.live || (manual.state.answered === state.answered && manual.state.answerSeq === state.answerSeq))
  )
    return manual.open;

  return state.live && !state.answered ? preferences.expandWhileWorking : preferences.keepAfterTurn;
}

export type TurnProgress = "live" | "completed" | "ended";

/** A turn's status as `answerIndex` needs it: interrupted, failed and cancelled turns have ended without completing. */
export function turnProgress(status: string): TurnProgress {
  if (status === "completed") return "completed";

  return ["interrupted", "failed", "cancelled"].includes(status) ? "ended" : "live";
}

/** A visible row of a turn's body for `answerIndex`: an agent message's phase ("" without one), or `undefined` for other work. */
export type BodyPhase = string | undefined;

/**
 * Index of the agent message shown outside the fold, or -1 (docs/timeline-folding.md).
 *
 * - An ended turn shows its last message: a completed turn always, others only if no work followed it.
 * - A live turn shows a message marked `final_answer` (Codex from its first delta, Claude when the
 *   message ends its turn) once nothing followed it.
 * - A live, unmarked message leaves the work only while the fold is open: a collapsed fold keeps it
 *   until a phase or the turn's end confirms it, so it never shows outside and folds back in.
 */
export function answerIndex(body: readonly BodyPhase[], status: TurnProgress, open: boolean): number {
  const at = body.findLastIndex((phase) => phase !== undefined);

  if (at < 0 || (status !== "completed" && at !== body.length - 1)) return -1;

  if (status !== "live") return at;
  const phase = body[at];

  return phase === "final_answer" || (!phase && open) ? at : -1;
}

/** A row of a turn's body for `workSegments`: its `BodyPhase`, and whether it is a steer (a message that joined the running turn). */
export interface BodyRow {
  readonly phase: BodyPhase;
  readonly steer: boolean;
}

/** One stretch of a turn laid out like a turn of its own: a fold, then its answer (docs/timeline-folding.md). */
export interface WorkSegment {
  /** Body rows `[start, end)`. */
  readonly start: number;
  readonly end: number;
  /** Leading steers shown above the fold, like a turn's input (segments after the first). */
  readonly inputs: number;
  /** Body index of the answer shown below the fold, or -1. */
  readonly answer: number;
  /** The turn is live and this is its last segment. */
  readonly live: boolean;
  /** Its answer is marked final: the fold follows "After the turn" instead of "While working". */
  readonly answered: boolean;
}

/** A segment's fold: the first keeps the turn's id, so its keys predate segments. */
export const foldId = (turnId: string, segment: number): string => (segment ? `${turnId}/${segment}` : turnId);

/**
 * A turn's body split into segments. A message marked `final_answer` that more rows follow ends its
 * segment and stays its answer: the work after it (a steer, a goal continuation, the agent going on)
 * starts the next one instead of pulling the answer back into the fold. The last segment's answer
 * follows `answerIndex` (`open`: its fold is open). Phases persist, so a reopened turn splits the same.
 */
export function workSegments(
  body: readonly BodyRow[],
  status: TurnProgress,
  open: (segment: number) => boolean,
): WorkSegment[] {
  const segments: WorkSegment[] = [];
  let start = 0;

  const inputs = (from: number, to: number) => {
    let at = from;

    if (segments.length > 0) while (at < to && body[at]!.steer) at++;

    return at - from;
  };

  body.forEach((row, at) => {
    if (row.phase !== "final_answer" || at === body.length - 1) return;
    segments.push({ start, end: at + 1, inputs: inputs(start, at), answer: at, live: false, answered: true });
    start = at + 1;
  });

  const rest = body.slice(start);

  const at = answerIndex(
    rest.map((row) => row.phase),
    status,
    open(segments.length),
  );

  segments.push({
    start,
    end: body.length,
    inputs: inputs(start, body.length),
    answer: at < 0 ? -1 : start + at,
    live: status === "live",
    answered: rest.at(-1)?.phase === "final_answer",
  });

  return segments;
}

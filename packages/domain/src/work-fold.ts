import type { Item } from "@canopy/contracts";

/** Published results shown after the turn, outside its work fold. */
export function isPublishedReply(content: Item["content"]): boolean {
  return content.case === "imageGallery" || content.case === "publishedVideo" || content.case === "visual";
}

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

/** Live choices expire at a steer, final answer or end; choices made after the end survive late items. */
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

export function isProgressPhase(phase: BodyPhase): boolean {
  return phase === "commentary" || phase === "partial_answer";
}

/**
 * Index of the agent message shown outside the fold, or -1 (docs/timeline-folding.md).
 *
 * - A completed turn shows its last message if its phase allows it to be an answer.
 *   An interrupted or failed turn only shows its last message if no work followed it.
 * - A live turn shows a message marked `final_answer` (Codex from its first delta, Claude when the
 *   message ends its turn) once nothing followed it.
 * - A live, unmarked message leaves the work only while the fold is open: a collapsed fold keeps it
 *   until a phase or the turn's end confirms it, so it never shows outside and folds back in.
 */
export function answerIndex(body: readonly BodyPhase[], status: TurnProgress, open: boolean): number {
  const at = body.findLastIndex((phase) => phase !== undefined);

  if (at < 0 || (status !== "completed" && at !== body.length - 1)) return -1;

  const phase = body[at];

  if (status === "completed") return isProgressPhase(phase) ? -1 : at;

  if (status === "ended") return at;

  return phase === "final_answer" || (!phase && open) ? at : -1;
}

/** A persisted row that starts a new visible segment boundary. */
export type WorkBoundary = "compaction";

/** A row of a turn's body for `workSegments`: its phase, steer marker and optional visible boundary. */
export interface BodyRow {
  readonly phase: BodyPhase;
  readonly steer: boolean;
  /** Context compaction is shown outside the preceding fold and starts the following segment. */
  readonly boundary?: WorkBoundary | undefined;
}

/** One stretch of a turn laid out like a turn of its own: a fold, then its answer (docs/timeline-folding.md). */
export interface WorkSegment {
  /** Body rows `[start, end)`. */
  readonly start: number;
  readonly end: number;
  /** Leading visible boundary rows shown above the fold, like a turn's input. */
  readonly inputs: number;
  /** Body index of the answer shown below the fold, or -1. */
  readonly answer: number;
  /** The turn is live and no later steer or final answer has ended this stretch of work. */
  readonly live: boolean;
  /** Its answer is marked final: the fold follows "After the turn" instead of "While working". */
  readonly answered: boolean;
  /** Final answer confirming this work, including segments before a steer; -1 until confirmed. */
  readonly answerBoundary: number;
}

/** A segment's fold: the first keeps the turn's id, so its keys predate segments. */
export const foldId = (turnId: string, segment: number): string => (segment ? `${turnId}/${segment}` : turnId);

/**
 * Split at final answers and before visible boundaries, keeping every injected input outside hidden work.
 * Consecutive leading boundaries share a segment. A steer ends preceding work and expires its live
 * fold choices; compaction alone preserves them. Only the last segment before a final answer can
 * supply that answer. Everything derives from persisted rows, including on replay.
 */
export function workSegments(
  body: readonly BodyRow[],
  status: TurnProgress,
  open: (segment: number) => boolean,
): WorkSegment[] {
  const segments: WorkSegment[] = [];
  const lastSteer = body.findLastIndex((row) => row.steer);
  let from = 0;

  const stretch = (end: number) => {
    const answerBoundary = body[end - 1]?.phase === "final_answer" ? end - 1 : -1;
    const live = status === "live" && end === body.length;
    let start = from;
    let inputs = 0;

    const push = (to: number) => {
      const at =
        to === end
          ? answerIndex(
              body.slice(start + inputs, to).map((row) => row.phase),
              end < body.length ? "completed" : status,
              open(segments.length),
            )
          : -1;

      segments.push({
        start,
        end: to,
        inputs,
        answer: at < 0 ? -1 : start + inputs + at,
        live: live && to > lastSteer,
        answered: answerBoundary >= 0,
        answerBoundary,
      });
    };

    for (let at = from; at < end; at++) {
      if (!body[at]!.steer && body[at]!.boundary === undefined) continue;

      if (at > start + inputs) {
        push(at);
        start = at;
        inputs = 0;
      }

      inputs++;
    }

    push(end);
    from = end;
  };

  body.forEach((row, at) => {
    if (row.phase === "final_answer" && at < body.length - 1) stretch(at + 1);
  });
  stretch(body.length);

  return segments;
}

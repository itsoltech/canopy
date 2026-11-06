/** When a turn's "Working for …" fold is open (web and mobile timelines, docs/timeline-folding.md). */
export interface WorkFoldPreferences {
  readonly expandWhileWorking: boolean;
  readonly keepAfterTurn: boolean;
}

/** Manual choices and an active reader take precedence over device defaults. */
export function workFoldOpen(
  live: boolean,
  answerStarted: boolean,
  preferences: WorkFoldPreferences,
  manual?: boolean,
  reading = false,
): boolean {
  return manual ?? (reading || (live && !answerStarted ? preferences.expandWhileWorking : preferences.keepAfterTurn));
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

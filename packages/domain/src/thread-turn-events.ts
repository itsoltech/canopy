import { create } from "@bufbuild/protobuf";
import { TurnEndSource, TurnOrigin, TurnOutcome, ui, type ThreadEvent } from "@canopy/contracts";
import { classifyFailure, safeFailureDetail } from "./failures.ts";

const outcomes = new Map([
  [TurnOutcome.COMPLETED, "completed"],
  [TurnOutcome.INTERRUPTED, "interrupted"],
  [TurnOutcome.FAILED, "failed"],
]);

const sources = new Map([
  [TurnEndSource.USER, "user"],
  [TurnEndSource.SYSTEM, "system"],
  [TurnEndSource.PLATFORM, "platform"],
  [TurnEndSource.HARNESS, "harness"],
]);

/** Provider wake-ups/recovery reach mobile as events before projected turns, just as they do the web. */
export function applyTurnEvent(turns: ui.Turn[], event: ThreadEvent): ui.Turn[] {
  if (!event.turnId) return turns;
  const index = turns.findIndex((turn) => turn.id === event.turnId && !turn.inherited);
  const turn = turns[index];
  const body = event.body;

  if (body.case === "turnStarted") {
    if (turn) return turns;
    const origin = body.value.origin;

    return [
      ...turns,
      create(ui.TurnSchema, {
        id: event.turnId,
        ordinal: Math.max(0, ...turns.flatMap((t) => (t.inherited ? [] : [t.ordinal]))) + 1,
        status: "running",
        trigger: origin === TurnOrigin.PROVIDER ? "provider" : origin === TurnOrigin.RECOVERY ? "recovery" : "user",
        queuedAt: event.occurredAt,
        startedAt: event.occurredAt,
      }),
    ];
  }

  if (body.case !== "turnFinished" || turn?.status !== "running") return turns;
  const finished = body.value;
  const status = outcomes.get(finished.outcome);

  if (!status) return turns;
  const source = sources.get(finished.source);

  return turns.with(index, {
    ...turn,
    status,
    completedAt: event.occurredAt,
    usage: finished.usage ?? turn.usage,
    ...(status === "failed" && {
      error: safeFailureDetail(finished.reason),
      errorSource: source || "harness",
      errorCode: finished.errorCode,
      errorClass: classifyFailure(finished.reason, finished.errorCode),
    }),
    ...(status === "interrupted" && { interruptReason: finished.reason, interruptSource: source || "user" }),
  });
}

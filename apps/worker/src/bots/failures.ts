import { classifyFailure } from "@canopy/domain";
import { TurnOutcome } from "@canopy/contracts";
import type { ThreadEventInit } from "../journal/index.ts";

/** Classify before dropping provider prose: no endpoint, prompt or credential enters the bot journal. */
export function botFailureEvent(event: ThreadEventInit): ThreadEventInit {
  if (event.body?.case !== "turnFinished" || event.body.value.outcome !== TurnOutcome.FAILED) return event;
  const end = event.body.value;

  return {
    ...event,
    body: {
      case: "turnFinished",
      value: {
        ...end,
        errorClass: classifyFailure(end.reason ?? "", end.errorClass || end.errorCode || ""),
        reason: "Bot harness could not finish this turn",
      },
    },
  };
}

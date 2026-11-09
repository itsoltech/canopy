import { classifyFailure } from "@canopy/domain";
import { TurnEndSource, TurnOutcome } from "@canopy/contracts";
import type { ThreadEventInit } from "../journal/index.ts";
import { BotHarnessFailure, type BotHarnessContext } from "./types.ts";

/** Journal the refusal before stopping the harness, even if its transcript later reports a completed turn. */
export async function rejectBotToolApproval(ctx: BotHarnessContext): Promise<never> {
  await ctx.record({
    body: {
      case: "turnFinished",
      value: {
        outcome: TurnOutcome.FAILED,
        source: TurnEndSource.HARNESS,
        errorCode: "tool_approval",
        errorClass: "tool_approval",
        reason: "The agent CLI blocked this Canopy tool before approval. Update the worker, then retry.",
      },
    },
  });
  throw new BotHarnessFailure("tool_approval");
}

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

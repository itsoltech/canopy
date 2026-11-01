import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { ui } from "@open-agents/contracts";
import { readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const Body = Schema.Struct({
  action: Schema.Literals(["set", "pause", "resume", "clear"]),
  // set: required (the gateway checks it and its 4000-character limit).
  objective: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4000))),
  // set: Codex's token budget; missing or 0 = no limit (Claude rejects one).
  tokenBudget: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))),
});

/** The thread's harness goal (SetGoal): set, pause, resume or clear. */
export const POST: RequestHandler = async ({ request, params }) => {
  const { action, objective = "", tokenBudget = 0 } = await readBody(request, Body);
  const response = await call((api) => api.setGoal({ threadId: params.threadId, action, objective, tokenBudget: BigInt(tokenBudget) }));
  return json(encode(ui.SetGoalResponseSchema, response));
};

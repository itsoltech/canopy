import type { BotRuntimeOptions, BotsRuntime } from "./runtime.ts";
import { currentBotTools } from "./policy.ts";
import { botConfiguration } from "./store-views.ts";
import { runToolCall, WAITING } from "./turn-steps.ts";
import type { BotTurn } from "./types.ts";

/**
 * A continuation of an approved parked card runs that call first, through the regular tool path, and gives the
 * model its result in the turn input. Returns the input the model reads.
 */
export async function runParkedApproval(
  runtime: BotsRuntime,
  options: BotRuntimeOptions,
  turn: BotTurn,
  abort: AbortController,
): Promise<string> {
  if (!turn.resume_approval_id || turn.handoff_configuration) return turn.input;

  const requested = await runtime.run((s) => s.resumeCall(turn));

  if (!requested) return turn.input;

  const config = botConfiguration(await runtime.run((s) => s.owned(options.userId, turn.bot_id)));
  const access = await runtime.run((s) => s.memoryAccess(options.userId, turn));
  const tools = await currentBotTools(options, config, turn, access);
  const step = { options, run: runtime.run.bind(runtime) };
  const result = await runToolCall(step, turn, abort, tools, requested);

  return runtime.run((s) => s.resumeResult(turn, result === WAITING ? { error: "Not run" } : result));
}

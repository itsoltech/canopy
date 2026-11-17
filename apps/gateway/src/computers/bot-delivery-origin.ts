import { BotStore } from "../bots/store.ts";
import { originOf, type RoutineOrigin } from "../bots/routines.ts";
import type { BotTurn } from "../bots/types.ts";
import type { Reference } from "./agents-context.ts";
import type { LinkedAgents } from "./agents.ts";

/** Local persisted tool calls identify where remote reports belong; peers never choose a conversation. */
export async function botDeliveryOrigin(host: LinkedAgents, ref: Reference): Promise<RoutineOrigin | undefined> {
  const source = (
    await host.query<BotTurn>(
      `SELECT t.* FROM bot_tool_calls c JOIN bot_turns t ON t.id=c.turn_id JOIN bots b ON b.id=t.bot_id
     WHERE c.id=$1::uuid AND t.bot_id=$2::uuid AND b.owner_user_id=$3::uuid`,
      [ref.call_id, ref.actor_id, host.owner],
    )
  )[0];

  if (source) {
    if (!(await host.scope.run(BotStore.use((s) => s.originEnabled(source))))) return undefined;

    return originOf(source);
  }

  return ref.source_routine_id ? { routineId: ref.source_routine_id, routineTitle: ref.source_routine_title } : {};
}

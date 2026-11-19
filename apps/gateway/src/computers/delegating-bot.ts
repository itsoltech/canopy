import type { AgentToolCall, computerLink } from "@canopy/contracts";
import { nodeRef, qualifyId, splitId } from "@canopy/domain/computers";
import { BotStore } from "../bots/store.ts";
import { originOf } from "../bots/routines.ts";
import type { BotTurn } from "../bots/types.ts";
import { DISPATCHED } from "../store/turn-select.ts";
import { botThreadNoticeTitle } from "../bots/thread-notice.ts";
import type { ThreadRow } from "../store/index.ts";
import { agentsState, requireLinkedChainCapacity, fail, text, uuid, type Arguments } from "./agents-context.ts";
import { requireAgentModules } from "./agents-module-access.ts";
import type { LinkedAgents } from "./agents.ts";

type Origin = Pick<BotTurn, "bot_id" | "conversation_id" | "routine_id" | "routine_title">;

const missing = "No active delegation from the bot that started this thread.";
const ambiguous = "This turn has more than one bot conversation. Finish the turn to report back.";

export async function messageLinkedDelegatingBot(
  host: LinkedAgents,
  request: AgentToolCall,
  caller: ThreadRow,
  message: string,
) {
  if (
    !caller.remote_parent_ref ||
    caller.remote_parent_detached ||
    caller.owner_user_id !== host.owner ||
    !uuid(request.turnId) ||
    !uuid(request.callId)
  )
    return fail(missing);
  await requireAgentModules(host, "thread", "bot");
  const parent = splitId(caller.remote_parent_ref);

  const watches = await host.query<{
    call_id: string;
    peer_node_id: string;
    actor_id: string;
    hops: number;
    local_watch: boolean;
  }>(
    `SELECT c.call_id,c.peer_node_id,c.actor_id,greatest(c.hops,u.hops) AS hops,
      EXISTS(SELECT 1 FROM bot_thread_watches w LEFT JOIN turn_steers ls ON ls.id=w.target_steer_id
        WHERE w.target_thread_id=th.id AND NOT w.delivered AND
          (CASE WHEN w.target_steer_id IS NULL THEN w.target_turn_id
            WHEN ls.status='delivered' THEN ls.turn_id WHEN ls.status='queued' THEN ls.queued_turn_id END)=u.id) AS local_watch
      FROM threads th JOIN turns u ON u.thread_id=th.id
      JOIN computer_agent_calls c ON c.target_id=th.id AND c.owner_user_id=th.owner_user_id
      LEFT JOIN turn_steers s ON s.id=c.target_steer_id
      WHERE th.id=$1::uuid AND th.owner_user_id=$2::uuid AND th.remote_parent_ref=$3
        AND th.remote_parent_kind='bot' AND NOT th.remote_parent_detached
        AND th.archived_at IS NULL AND th.deleted_at IS NULL
        AND th.rewind_pending_id IS NULL AND u.id=$4::uuid AND u.rewind_id IS NULL
        AND (u.status='running' OR (u.status='queued' AND ${DISPATCHED}))
        AND c.direction='incoming' AND c.actor_kind='bot' AND c.target_kind='thread' AND c.notify
        AND NOT c.detached AND c.report_status='pending'
        AND (CASE WHEN c.target_steer_id IS NULL THEN c.target_turn_id
          WHEN s.status='delivered' THEN s.turn_id WHEN s.status='queued' THEN s.queued_turn_id END)=u.id`,
    [caller.id, host.owner, caller.remote_parent_ref, request.turnId],
  );

  const first = watches[0];

  if (!first) return fail(missing);

  if (watches.some((w) => w.local_watch || nodeRef(w.peer_node_id) !== parent.node || w.actor_id !== parent.id))
    return fail(ambiguous);

  const hops = watches.reduce((max, watch) => Math.max(max, watch.hops), 0) + 1;
  requireLinkedChainCapacity(hops, false);

  return host.call(
    first.peer_node_id,
    "message_delegating_bot",
    { kind: "thread", id: caller.id, hops, name: botThreadNoticeTitle(caller.title) },
    request.callId,
    { watches: watches.map((w) => w.call_id), text: message },
  );
}

/** The thread home knows which steers entered the turn. Only the bot home knows their conversation. */
export async function receiveDelegatingBotMessage(
  host: LinkedAgents,
  node: string,
  call: computerLink.LinkedAgentCall,
  args: Arguments,
) {
  const watches = args["watches"];

  if (
    call.actorKind !== "thread" ||
    !Array.isArray(watches) ||
    !watches.length ||
    !watches.every((id): id is string => typeof id === "string" && uuid(id))
  )
    return fail(missing);
  const message = text(args, "text");

  await Promise.all(watches.map((watch) => host[agentsState].pendingBotSpawns.get(`${node}:${watch}`)));

  return host.scope.transaction(async () => {
    await requireAgentModules(host, "thread", "bot", true);

    const active = await host.query(
      "SELECT node_id FROM computer_peers WHERE owner_user_id=$1::uuid AND node_id=$2 FOR UPDATE",
      [host.owner, node],
    );

    if (!active.length) return fail("That computer is no longer linked");

    const sources = await host.query<Origin & { watch_hops: number; matching: number }>(
      `SELECT t.bot_id,t.conversation_id,t.routine_id,max(t.routine_title) AS routine_title,
        max(w.hops) AS watch_hops,count(*)::int AS matching FROM computer_agent_calls w
       JOIN bot_tool_calls c ON c.id=w.call_id JOIN bot_turns t ON t.id=c.turn_id AND t.bot_id=w.actor_id
       JOIN bots b ON b.id=t.bot_id AND b.owner_user_id=w.owner_user_id
       WHERE w.owner_user_id=$1::uuid AND w.peer_node_id=$2 AND w.direction='outgoing'
         AND w.actor_kind='bot' AND w.target_kind='thread' AND w.call_id=ANY($3::uuid[]) AND w.notify
         AND NOT w.detached AND w.report_status<>'dropped'
         AND w.target_id=$4::uuid
         AND EXISTS(SELECT 1 FROM computer_agent_calls p WHERE p.owner_user_id=w.owner_user_id
           AND p.peer_node_id=w.peer_node_id AND p.actor_id=w.actor_id AND p.actor_kind='bot' AND p.parent_link
           AND p.direction='outgoing' AND NOT p.detached AND p.target_id=w.target_id)
       GROUP BY t.bot_id,t.conversation_id,t.routine_id LIMIT 2`,
      [host.owner, node, watches, call.actorId],
    );

    const source = sources[0];

    if (sources.length > 1) return fail(ambiguous);

    if (!source || source.matching !== watches.length) return fail(missing);
    const hops = Math.max(call.hops, source.watch_hops + 1);
    requireLinkedChainCapacity(hops, false);

    const sender = qualifyId(call.actorId, node);
    const title = botThreadNoticeTitle(text(args, "sender_name", true));

    const turn = await host.scope.run(
      BotStore.use((s) =>
        s.enqueue(
          host.owner,
          source.bot_id,
          `Message from the running thread "${title}" (thread_id: ${sender}):\n${message}`,
          `thread-message:${sender}:${call.callId}`,
          { ...originOf(source), sender, hops, event: true, displayText: message },
        ),
      ),
    );

    return { bot_id: source.bot_id, turn_id: turn, delivery: "queue" };
  });
}

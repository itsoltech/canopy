import type { BotTurn, StoredCall } from "../bots/types.ts";
import { botMemoryAccess } from "../bots/memory.ts";
import { usesThreadConnection } from "../bots/thread-tools.ts";
import { Predicate } from "effect";
import { SqlClient } from "effect/sql";
import { splitId } from "@canopy/domain/computers";
import { isUuid } from "../store/agent-bus-queries.ts";
import { Invalid } from "../store/errors.ts";
import { coreState } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";

export const THREAD_AUDIENCE_ERROR = "Choose a thread delegated from this conversation, or start a new thread here.";

/**
 * Only the scheduler assigns the wakeup key with the stored positive hop. That receipt survives a
 * harness retry moving the input message. Every ancestor consumes one hop and belongs to the same bot.
 */
function priorWakeupTurns(sql: SqlClient.SqlClient, turn: BotTurn) {
  return sql<{ turn_id: string }>`WITH RECURSIVE lineage(turn_id, source_turn_id, hops) AS (
    SELECT NULL::uuid, ${turn.id}::uuid, ${turn.hops}::int + 1
    UNION ALL
    SELECT t.id, c.turn_id, t.hops
    FROM lineage l
    JOIN bot_turns t ON t.id=l.source_turn_id AND t.bot_id=${turn.bot_id}::uuid AND t.hops=l.hops-1
    JOIN bot_wakeups w ON w.id=CASE
      WHEN starts_with(t.client_request_id,'wakeup:') AND pg_input_is_valid(substr(t.client_request_id,8),'uuid')
      THEN substr(t.client_request_id,8)::uuid END
      AND t.client_request_id='wakeup:' || w.id::text
      AND w.bot_id=t.bot_id AND w.hops=t.hops AND w.hops>0 AND w.delivered
    JOIN bot_tool_calls c ON c.id=w.id AND c.tool->>'source'='platform' AND c.tool->>'name'='schedule_wakeup'
    WHERE t.conversation_id IS NULL AND t.routine_id IS NULL AND t.handoff_configuration IS NULL
      AND t.reply_to_bot_id IS NULL AND t.exchange_id IS NULL AND t.remote_recipient_ref IS NULL
  ) SELECT turn_id FROM lineage WHERE turn_id<>${turn.id}::uuid`;
}

/** The lease, durable input and reply recipient determine capability even when a native bot session is reused. */
export async function botThreadAudience(core: GatewayCore, turn: BotTurn): Promise<string> {
  const { actions, options } = core[coreState];
  const access = await actions.run(SqlClient.SqlClient.use((sql) => botMemoryAccess(sql, options.userId, turn)));
  const scope = access.scopes[0];

  if (scope?.kind === "conversation") return `conversation:${scope.botId}:${scope.conversationId}`;

  if (scope?.kind === "bot" && access.canWrite) return "";

  if (scope?.kind === "bot" && turn.routine_id) return `routine:${scope.botId}:${turn.routine_id}`;

  return `turn:${turn.bot_id}:${turn.id}`;
}

/** An empty list means an owner-wide read. Continuing a delegation can include prior wakeup turns. */
export async function botThreadAudiences(core: GatewayCore, turn: BotTurn, includePriorWakeups: boolean) {
  const current = await botThreadAudience(core, turn);

  if (!current) return [];

  if (!includePriorWakeups || !current.startsWith("turn:") || !turn.client_request_id.startsWith("wakeup:"))
    return [current];
  const { actions } = core[coreState];
  const ancestors = await actions.run(SqlClient.SqlClient.use((sql) => priorWakeupTurns(sql, turn)));

  return [current, ...ancestors.map(({ turn_id }) => `turn:${turn.bot_id}:${turn_id}`)];
}

export async function requireThreadAudience(
  core: GatewayCore,
  id: string,
  audiences: readonly string[],
  writing: boolean,
) {
  if (!audiences.length && !writing) return;
  const { actions, options } = core[coreState];

  const rows = await actions.run(
    SqlClient.SqlClient.use(
      (sql) =>
        sql`SELECT id FROM threads WHERE id=${id}::uuid AND owner_user_id=${options.userId}::uuid
      AND deleted_at IS NULL AND moved_to IS NULL AND memory_audience=ANY(${audiences.length ? [...audiences] : [""]}::text[])`,
    ),
  );

  if (!rows.length) throw new Invalid(THREAD_AUDIENCE_ERROR);
}

/** A private callback can answer its delivered question without opening the watched thread's transcript. */
async function deliveredQuestion(core: GatewayCore, turn: BotTurn, call: StoredCall) {
  const id = call.arguments["thread_id"];

  if (!Predicate.isString(id) || !isUuid(id) || !["answer_interaction", "read_thread"].includes(call.tool.name)) return;
  const { actions, options } = core[coreState];

  const [row] = await actions.run(
    SqlClient.SqlClient.use(
      (sql) => sql<{ request_id: string }>`
    SELECT d.request_id FROM bot_thread_question_deliveries d
    JOIN bot_thread_watches w ON w.call_id=d.call_id
    JOIN bot_tool_calls c ON c.id=w.call_id JOIN bot_turns origin ON origin.id=c.turn_id AND origin.bot_id=w.bot_id
    JOIN threads th ON th.id=w.target_thread_id AND th.owner_user_id=${options.userId}::uuid
    JOIN interaction_requests q ON q.id=d.request_id AND q.thread_id=th.id AND q.status='pending'
    JOIN bot_turns t ON t.bot_id=w.bot_id
    LEFT JOIN bot_messages m ON m.turn_id=t.id AND m.bot_id=t.bot_id AND m.message_key='input'
    WHERE t.id=${turn.id}::uuid AND t.status='running' AND t.lease_token=${turn.lease_token}::uuid AND t.lease_until>now()
      AND th.id=${id}::uuid AND th.archived_at IS NULL AND th.deleted_at IS NULL AND th.moved_to IS NULL
      AND t.conversation_id IS NULL AND t.reply_to_bot_id IS NULL AND t.exchange_id IS NULL AND t.remote_recipient_ref IS NULL
      AND t.client_request_id=('thread-question:' || d.call_id::text || ':' || d.request_id::text)
      AND t.hops=w.hops AND origin.conversation_id IS NULL AND t.routine_id IS NOT DISTINCT FROM origin.routine_id
      AND (t.routine_id IS NOT NULL OR (m.sender_id=th.id::text AND m.kind='event'))`,
    ),
  );

  if (row && (call.tool.name === "read_thread" || call.arguments["request_id"] === row.request_id))
    return row.request_id;

  return undefined;
}

/** Check before any approval preview or history fetch. Remote history is attested by its own home. */
export async function authorizeBotThreadCall(core: GatewayCore, turn: BotTurn, call: StoredCall) {
  if (
    call.tool.source !== "platform" ||
    (!usesThreadConnection(call.tool.name) && call.tool.name !== "send_bot_message")
  )
    return;
  const name = call.tool.name;
  const audiences = await botThreadAudiences(core, turn, ["get_thread", "read_thread", "send_message"].includes(name));

  const keys = ["thread_id", "parent_thread_id", "request_id", "bot_id"];

  if (name === "start_thread" || name === "fork_thread") keys.push("workspace_id", "project_id");

  for (const key of keys) {
    const id = call.arguments[key];

    if (!Predicate.isString(id)) continue;

    const ref =
      key === "thread_id" || key === "parent_thread_id"
        ? (core.computers?.redirects.map("thread", id) ?? id)
        : key === "bot_id"
          ? (core.computers?.redirects.map("bot", id) ?? id)
          : id;

    // A bot exchange can cross homes because the destination must accept an isolated bot turn.
    if (name === "send_bot_message" && key === "bot_id" && !turn.conversation_id) continue;

    if (audiences.length && splitId(ref).node)
      throw new Invalid("Choose a thread on this computer for delegated work from this conversation.");
  }

  if (
    audiences.length &&
    (["create_schedule", "update_schedule", "set_schedule_status"].includes(name) ||
      (["list_schedules", "cancel_schedule"].includes(name) && call.arguments["scope"] !== "wakeup"))
  )
    throw new Invalid("Platform schedules are unavailable to this conversation.");

  if (audiences.length) {
    const question = await deliveredQuestion(core, turn, call);

    if (question) return question;
  }

  const writing = ["start_thread", "fork_thread", "send_message", "set_goal", "answer_interaction"].includes(name);

  for (const key of ["thread_id", "parent_thread_id"]) {
    const target = call.arguments[key];

    if (!Predicate.isString(target)) continue;
    const ref = core.computers?.redirects.map("thread", target) ?? target;

    if (!splitId(ref).node) await requireThreadAudience(core, ref, audiences, writing);
  }

  return undefined;
}

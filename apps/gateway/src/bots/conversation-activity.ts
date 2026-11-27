import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { activeConversationSource } from "../messengers/conversation-access.ts";
import { messengerActivityContext } from "../messengers/activity-label.ts";
import { messengerLabel, type MessengerProvider } from "../messengers/provider.ts";
import { activityLabel } from "./activity-event.ts";
import { ownerModule } from "../store/module-access.ts";
import { statusPhrase } from "./policy.ts";
import type { BotRow, ToolSpec } from "./types.ts";

type ActivityTool = Pick<ToolSpec, "name" | "source" | "serverName" | "remoteName">;

interface ActivityRow {
  id: string;
  status: string;
  working: boolean;
  routine_id: string | null;
  routine_title: string;
  account: string | null;
  provider: MessengerProvider | null;
  direct: boolean | null;
  channel_id: string | null;
  thread_id: string | null;
  streaming_text: string;
}

function sourceLabel(turn: ActivityRow) {
  if (turn.channel_id) {
    const context = messengerActivityContext(
      turn.account ?? "",
      turn.channel_id,
      turn.thread_id ?? "",
      turn.direct === true,
    );

    const provider = messengerLabel(turn.provider ?? "slack");

    return context ? `${provider} · ${context}` : provider;
  }

  if (!turn.routine_id) return "";
  const title = activityLabel(turn.routine_title).slice(0, 120);

  return title ? `Routine “${title}”` : "Routine";
}

function backgroundPhase(sql: SqlClient.SqlClient, turn: ActivityRow, statusLine: string) {
  return Effect.gen(function* () {
    if (turn.status === "queued") return "Queued";

    if (turn.status === "waiting") return "Waiting for you";

    if (statusLine === "Waiting for a worker") return statusLine;

    // Calls can run in parallel. A pending decision takes precedence over tool execution.
    // Only gateway catalogue metadata is eligible for the owner-facing label.
    const [call] = yield* sql<{ tool: ActivityTool; waiting: boolean }>`SELECT
      jsonb_strip_nulls(jsonb_build_object('name', c.tool->>'name', 'source', c.tool->>'source',
        'serverName', c.tool->>'serverName', 'remoteName', c.tool->>'remoteName')) AS tool,
      a.id IS NOT NULL AS waiting
      FROM bot_tool_calls c LEFT JOIN bot_approvals a ON a.id=c.id AND a.status='pending'
      WHERE c.turn_id=${turn.id}::uuid AND c.status IN ('pending','running')
      ORDER BY (a.id IS NOT NULL) DESC,c.id DESC LIMIT 1`;

    if (call?.waiting) return "Waiting for you";

    return call ? activityLabel(statusPhrase(call.tool)).slice(0, 120) : "Typing…";
  });
}

/** Stop and streaming belong to the owner's conversation. The live line describes the turn actually running. */
export function conversationActivity(sql: SqlClient.SqlClient, bot: BotRow) {
  return Effect.gen(function* () {
    const [turn] =
      yield* sql<ActivityRow>`SELECT t.id,t.status,t.routine_id,t.routine_title,slack.account,slack.provider,slack.direct,slack.channel_id,slack.thread_id,
      bool_or(t.conversation_id IS NULL AND (t.routine_id IS NULL OR t.status='waiting')) OVER () AS working,
      coalesce(h.text,'') AS streaming_text
      FROM bot_turns t
      LEFT JOIN LATERAL (SELECT a.name AS account,a.provider,c.direct,c.channel_id,c.thread_id
        ${activeConversationSource(sql, bot.id, sql`t.conversation_id`)}) slack ON t.conversation_id IS NOT NULL
      LEFT JOIN bot_harness_turns h ON h.turn_id=t.id AND h.bot_id=t.bot_id AND t.status='running'
        AND t.routine_id IS NULL AND t.conversation_id IS NULL
      WHERE t.bot_id=${bot.id}::uuid AND t.handoff_configuration IS NULL AND NOT t.reaction_input AND t.status IN ('queued','running','waiting')
        AND (t.conversation_id IS NULL OR slack.channel_id IS NOT NULL)
        AND ${ownerModule(sql, bot.owner_user_id, "bots")}
      ORDER BY CASE t.status WHEN 'running' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END,t.created_at,t.id LIMIT 1`;

    if (!turn) return { statusLine: "", streamingText: "", working: false };
    const source = sourceLabel(turn);

    const statusLine = source
      ? `${yield* backgroundPhase(sql, turn, bot.status_line)} · ${source}`
      : turn.status === "queued"
        ? ""
        : bot.status_line;

    return { statusLine, streamingText: turn.streaming_text, working: turn.working };
  });
}

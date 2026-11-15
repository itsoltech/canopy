import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { ItemSchema, ItemStatus, ui } from "@canopy/contracts";
import { splitReplySuggestions } from "@canopy/domain/reply-suggestions";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { GatewayCore } from "./core.ts";
import { coreState, InvalidError } from "./core-context.ts";
import { ReplySuggestionExpired } from "../store/errors.ts";

/** Called after replay, inside SendMessage's owner-scoped thread lock and admission transaction. */
export async function checkReplySuggestion(core: GatewayCore, request: ui.SendMessageRequest): Promise<void> {
  const itemId = request.replySuggestionItemId;

  if (itemId === undefined) return;

  if (!itemId || itemId.length > 200)
    throw new InvalidError("This reply is not available. Write a message to continue.");

  const rows = await core[coreState].actions.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql<{ content: JsonValue }>`SELECT i.content FROM thread_items i
        JOIN turns u ON u.id=i.turn_id AND u.thread_id=i.thread_id
        JOIN threads t ON t.id=i.thread_id
        LEFT JOIN thread_events answer_start ON answer_start.thread_id=i.thread_id AND answer_start.seq=i.first_seq
        WHERE i.thread_id=${request.threadId}::uuid AND i.item_id=${itemId}
          AND t.owner_user_id=${core[coreState].options.userId}::uuid
          AND i.parent_item_id IS NULL AND i.type='agent_message' AND i.status='completed'
          AND u.status='completed' AND u.rewind_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM turns newer WHERE newer.thread_id=t.id
            AND newer.rewind_id IS NULL AND (newer.ordinal>u.ordinal OR newer.status IN ('queued','running')))
          AND NOT EXISTS (SELECT 1 FROM thread_items newer WHERE newer.thread_id=t.id
            AND newer.turn_id=u.id AND newer.parent_item_id IS NULL
            AND newer.type='agent_message' AND newer.first_seq>i.first_seq)
          AND NOT EXISTS (SELECT 1 FROM thread_items newer JOIN turns source ON source.id=newer.turn_id
            WHERE newer.thread_id=t.id AND source.rewind_id IS NULL AND newer.parent_item_id IS NULL
              AND newer.type='user_message' AND newer.first_seq>i.first_seq)
          AND NOT EXISTS (SELECT 1 FROM turn_steers s JOIN turns source ON source.id=s.turn_id
            WHERE s.thread_id=t.id AND source.rewind_id IS NULL
              AND (s.status IN ('pending','accepted') OR s.delivered_seq>i.first_seq
                OR coalesce((s.input->>'admittedAfterSeq')::bigint>=i.first_seq,
                  s.created_at>=coalesce(answer_start.recorded_at,u.completed_at))))`;
    }),
  );

  const item = rows[0] && fromJson(ItemSchema, rows[0].content);

  if (
    !item ||
    item.status !== ItemStatus.COMPLETED ||
    item.content.case !== "agentMessage" ||
    (item.content.value.phase !== "final_answer" && item.content.value.phase !== "")
  )
    throw new ReplySuggestionExpired();

  if (!splitReplySuggestions(item.content.value.text).replies.includes(request.text))
    throw new InvalidError("This reply changed. Write a message to continue.");
}

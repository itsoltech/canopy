import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { bots } from "@canopy/contracts";
import { Effect, Match, Schema } from "effect";
import { Invalid } from "../store/store.ts";
import type { SqlClient } from "effect/sql";
import type { InteractionRow } from "../store/rows.ts";
import { approvalFields } from "./approval-fields.ts";
import { isJsonObject } from "./json.ts";

interface ThreadApprovalRow extends InteractionRow {
  bot_id: string;
  title: string;
  allowed_by_bot_rule: JsonValue | null;
}

/** A view of the original request. It has no independent answer/status row. */
const view = (r: ThreadApprovalRow) =>
  create(bots.BotApprovalSchema, {
    id: r.id,
    requestId: r.id,
    botId: r.bot_id,
    threadId: r.thread_id,
    turnId: r.turn_id ?? "",
    kind: "approval",
    prompt: `Needs approval · ${r.tool_name || "Using a tool"} in “${r.title}”`,
    fields: isJsonObject(r.request) ? approvalFields(r.request) : [],
    status: threadApprovalStatus(r.status),
    createdAt: timestampFromDate(new Date(r.created_at)),
    expiresAt: r.expires_at ? timestampFromDate(new Date(r.expires_at)) : undefined,
    allowedByRule: r.allowed_by_bot_rule ? fromJson(bots.BotApprovalRuleSchema, r.allowed_by_bot_rule) : undefined,
  });

export const threadApprovalStatus = (status: string) =>
  Match.value(status).pipe(
    Match.when("pending", () => "pending"),
    Match.when("allowed", () => "approved"),
    Match.when("expired", () => "expired"),
    Match.orElse(() => "discarded"),
  );

export function botThreadApprovals(sql: SqlClient.SqlClient) {
  const rows = (user: string, botId: string, pending = false) => sql<ThreadApprovalRow>`
    SELECT q.*, s.bot_id, t.title FROM bot_started_threads s
    JOIN bots b ON b.id = s.bot_id JOIN threads t ON t.id = s.thread_id
    JOIN interaction_requests q ON q.thread_id = t.id
    WHERE b.owner_user_id = ${user}::uuid AND t.owner_user_id = b.owner_user_id
      AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL
      AND q.kind = 'permission' AND (${botId} = '' OR b.id::text = ${botId})
      AND (NOT ${pending} OR q.status = 'pending') ORDER BY q.created_at, q.id`;

  return {
    threadApprovals: (user: string, botId: string, pending = false) =>
      rows(user, botId, pending).pipe(Effect.map((r) => r.map(view))),
    threadApproval: (user: string, requestId: string) =>
      sql<ThreadApprovalRow>`SELECT q.*, '' AS bot_id, t.title FROM interaction_requests q
        JOIN threads t ON t.id = q.thread_id WHERE q.id = ${requestId}::uuid
          AND t.owner_user_id = ${user}::uuid AND q.kind = 'permission'`.pipe(
        Effect.map((r) => (r[0] ? view(r[0]) : undefined)),
      ),
    pendingThreadApprovals: (user: string, request: bots.ListThreadApprovalsRequest) =>
      Effect.gen(function* () {
        const ids = [request.threadId, ...request.otherThreadIds];

        if (ids.length > 512 || ids.some((id) => !Schema.is(Schema.String.check(Schema.isUUID()))(id)))
          return yield* Effect.fail(new Invalid("Choose up to 512 threads on one computer."));

        const pending = yield* sql.unsafe<ThreadApprovalRow>(
          `SELECT q.*, '' AS bot_id, t.title FROM interaction_requests q
          JOIN threads t ON t.id = q.thread_id JOIN turns u ON u.id = q.turn_id
          WHERE t.id = ANY($1::uuid[]) AND t.owner_user_id = $2::uuid
          AND t.archived_at IS NULL AND t.deleted_at IS NULL AND t.moved_to IS NULL
          AND q.kind = 'permission' AND q.status = 'pending' AND u.status IN ('running', 'queued', 'waiting')
          ORDER BY q.created_at, q.id`,
          [ids, user],
        );

        return pending.map(view);
      }),
  };
}

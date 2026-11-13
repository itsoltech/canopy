import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid, NotFound } from "./errors.ts";
import type { SteerStore } from "./steers.ts";

/** Claim each file with the message, atomically; the containing turn scopes worker blob access. */
export function createSteer(sql: SqlClient.SqlClient, request: Parameters<SteerStore["Service"]["create"]>[0]) {
  return sql.withTransaction(
    Effect.gen(function* () {
      const { threadId, turnId, text, userId, clientRequestId, model, effort, permissionMode, input, linked } = request;

      const admission = yield* sql<{ rewind_pending_id: string | null }>`SELECT rewind_pending_id FROM threads
        WHERE id = ${threadId}::uuid FOR UPDATE`;

      if (admission[0]?.rewind_pending_id)
        return yield* Effect.fail(new Invalid("This thread is rewinding. Wait for it to finish."));
      const id = Bun.randomUUIDv7();

      const rows = yield* sql<{ id: string }>`
        INSERT INTO turn_steers (id, thread_id, turn_id, input, author_user_id, client_request_id, model, effort, permission_mode, linked_call_id, hops)
        VALUES (${id}::uuid, ${threadId}::uuid, ${turnId}::uuid, ${JSON.stringify(input ?? { text })}::jsonb, ${linked ? null : userId}::uuid,
                ${clientRequestId || null}, ${model}, ${effort}, ${permissionMode}, ${linked?.callId ?? null}::uuid, ${linked?.hops ?? 0})
        ON CONFLICT (thread_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING RETURNING id`;

      if (!rows[0]) {
        const existing = yield* sql<{ id: string }>`SELECT id FROM turn_steers
          WHERE thread_id = ${threadId}::uuid AND client_request_id = ${clientRequestId}`;

        return existing[0]?.id ?? (yield* Effect.fail(new NotFound("steer not found")));
      }

      const attachments = input?.attachments ?? [];

      if (attachments.length > 0) {
        const bound = yield* sql`UPDATE attachments SET thread_id = ${threadId}::uuid, turn_id = ${turnId}::uuid
          WHERE id = ANY(${attachments.map((a) => a.id)}::uuid[])
            AND owner_user_id = ${userId}::uuid AND thread_id IS NULL AND bot_id IS NULL RETURNING id`;

        if (bound.length !== attachments.length)
          return yield* Effect.fail(new Invalid("an attachment was already sent with another message"));
      }

      return rows[0].id;
    }),
  );
}

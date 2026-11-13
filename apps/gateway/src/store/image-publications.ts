import { type JsonValue } from "@bufbuild/protobuf";
import { IMAGE_REPLY_LIMITS } from "@canopy/domain/image-replies";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { CallSource } from "./agent-bus-types.ts";
import { Invalid } from "./store.ts";
import type { ImageMessageSource } from "./image-message.ts";

export interface ImagePublication {
  source: CallSource;
  ownerId: string;
  workerId: string;
  requestHash: string;
  count: number;
  maxBytes: number;
  markdown?: ImageMessageSource;
}

export interface ImageLease {
  token: string;
  budget: number;
  expiresAt: Date;
}

/** Always acquire the execution row before attachments/timeline replication locks. */
export function lockImageSource(sql: SqlClient.SqlClient, input: ImagePublication) {
  return Effect.gen(function* () {
    const thread = yield* sql`SELECT id FROM threads WHERE id=${input.source.threadId}::uuid
      AND owner_user_id=${input.ownerId}::uuid AND worker_id=${input.workerId}::uuid
      AND deleted_at IS NULL AND archived_at IS NULL FOR UPDATE`;

    const turn = yield* sql`SELECT id FROM turns WHERE id=${input.source.turnId}::uuid
      AND thread_id=${input.source.threadId}::uuid AND status='running' FOR UPDATE`;

    if (!thread.length || !turn.length) return yield* Effect.fail(new Invalid("This turn is no longer running."));
  });
}

/** Idempotency and concurrency are shared by every gateway process, including after a restart. */
export function reserveImages(sql: SqlClient.SqlClient, input: ImagePublication) {
  return sql.withTransaction(
    Effect.gen(function* () {
      yield* lockImageSource(sql, input);
      yield* sql`SELECT id FROM workers WHERE id=${input.workerId}::uuid FOR UPDATE`;

      const completed = yield* sql<{ source_thread_id: string; result: JsonValue | null; status: string }>`
        SELECT source_thread_id,result,status FROM agent_bus_calls WHERE id=${input.source.callId}::uuid`;

      if (completed[0]) {
        if (completed[0].source_thread_id !== input.source.threadId || completed[0].status !== "completed")
          return yield* Effect.fail(new Invalid("This image publication is unavailable. Use a new call."));

        return { result: completed[0].result ?? {} };
      }

      const previous = yield* sql<{ thread_id: string; request_hash: string; active: boolean }>`
        SELECT thread_id,request_hash,expires_at > now() AS active FROM thread_image_publications
        WHERE call_id=${input.source.callId}::uuid`;

      if (previous[0]) {
        if (previous[0].thread_id !== input.source.threadId || previous[0].request_hash !== input.requestHash)
          return yield* Effect.fail(new Invalid("This call already identifies another image publication."));

        if (previous[0].active) return { wait: true } as const;
      }

      yield* sql`DELETE FROM thread_image_publications WHERE state='reserved' AND expires_at<=now()
        AND worker_id=${input.workerId}::uuid`;

      const active = yield* sql<{ thread_id: string }>`SELECT thread_id FROM thread_image_publications
        WHERE worker_id=${input.workerId}::uuid AND state='reserved' AND expires_at>now()`;

      if (active.length >= 2 || active.some((row) => row.thread_id === input.source.threadId))
        return yield* Effect.fail(new Invalid("Images are already being prepared. Try again when they finish."));

      const totals = yield* sql<{ count: string; bytes: string }>`
        SELECT coalesce(sum(image_count),0)::text AS count,coalesce(sum(size_bytes),0)::text AS bytes
        FROM thread_image_publications WHERE turn_id=${input.source.turnId}::uuid
          AND (state='committed' OR expires_at>now())`;

      const budget = Math.min(input.maxBytes, IMAGE_REPLY_LIMITS.turnBytes - Number(totals[0]!.bytes));

      if (Number(totals[0]!.count) + input.count > IMAGE_REPLY_LIMITS.turnCount || budget <= 0)
        return yield* Effect.fail(new Invalid("This turn reached its image limit. Show fewer images in a new turn."));

      const token = Bun.randomUUIDv7();

      const rows = yield* sql<{ expires_at: Date }>`INSERT INTO thread_image_publications
        (call_id,thread_id,turn_id,worker_id,request_hash,lease_token,expires_at,state,image_count,size_bytes)
        VALUES (${input.source.callId}::uuid,${input.source.threadId}::uuid,${input.source.turnId}::uuid,
          ${input.workerId}::uuid,${input.requestHash},${token}::uuid,now()+interval '60 seconds','reserved',
          ${input.count},${budget}) RETURNING expires_at`;

      return { lease: { token, budget, expiresAt: new Date(rows[0]!.expires_at) } };
    }),
  );
}

export function releaseImages(sql: SqlClient.SqlClient, callId: string, token: string) {
  return sql`DELETE FROM thread_image_publications WHERE call_id=${callId}::uuid
    AND lease_token=${token}::uuid AND state='reserved'`.pipe(Effect.asVoid);
}

import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid } from "../store/errors.ts";
import { decodeDraft, type DraftRow } from "./store.ts";
import { uuid } from "./content.ts";

export const draftClock = (sql: SqlClient.SqlClient, owner: string) =>
  sql<{ revision: bigint }>`SELECT revision FROM composer_draft_clock WHERE owner_user_id=${owner}::uuid`.pipe(
    Effect.map((rows) => BigInt(rows[0]?.revision ?? 0)),
  );

export function listComposerDrafts(sql: SqlClient.SqlClient, owner: string, request: ui.ListComposerDraftsRequest) {
  return sql.withTransaction(
    Effect.gen(function* () {
      const count = Math.max(1, Math.min(request.pageSize || 20, 50));
      const [time = "", id = ""] = request.pageToken.split("|");

      if (request.pageToken && (!/^\d{10,16}$/.test(time) || !uuid.test(id)))
        return yield* Effect.fail(new Invalid("This drafts page expired. Open Drafts again."));

      const rows = yield* sql<DraftRow & { page_time: string }>`SELECT *,
      (extract(epoch FROM updated_at)*1000000)::bigint::text AS page_time FROM composer_drafts
      WHERE owner_user_id=${owner}::uuid AND device_id<>${request.deviceId} AND (taken_by IS NULL OR taken_by=${request.deviceId})
        AND NOT sent AND sending_request_id IS NULL AND expires_at>now()
        AND (${request.threadId}='' OR target_thread_ref=${request.threadId})
        AND (${time}='' OR (updated_at,id)<(to_timestamp(${Number(time || 0) / 1000000}),${id || "00000000-0000-0000-0000-000000000000"}::uuid))
      ORDER BY updated_at DESC,id DESC LIMIT ${count + 1} FOR UPDATE SKIP LOCKED`;

      const visible = rows.slice(0, count);
      const last = visible.at(-1);

      return create(ui.ComposerDraftPageSchema, {
        drafts: visible.map(decodeDraft),
        nextPageToken: rows.length > count && last ? `${last.page_time}|${last.id}` : "",
        changeRevision: yield* draftClock(sql, owner),
      });
    }),
  );
}

/** The small draft receipt expires 30 days after success; native message deduplication remains. */
export const pruneComposerDrafts = (sql: SqlClient.SqlClient, owner: string) =>
  sql`DELETE FROM composer_drafts WHERE id IN (SELECT id FROM composer_drafts
    WHERE owner_user_id=${owner}::uuid AND expires_at<now() AND sending_request_id IS NULL
    ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING id`.pipe(Effect.map((rows) => rows.length));

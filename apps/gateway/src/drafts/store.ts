import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid, NotFound } from "../store/errors.ts";
import { SettingsConflict } from "../store/settings.ts";
import { draftTargetKey, uuid, validateDraft } from "./content.ts";
import { splitId } from "@canopy/domain/computers";

export interface DraftRow {
  owner_user_id: string;
  id: string;
  device_id: string;
  target_key: string;
  payload: Uint8Array;
  revision: bigint;
  mutation_id: string;
  taken_by: string | null;
  claim_id: string | null;
  sending_request_id: string | null;
  sent: boolean;
  send_kind: string | null;
  send_request: Uint8Array | null;
  delivery_request_id: string | null;
  send_attempt_id: string | null;
}

export const conflict = () =>
  new SettingsConflict("This draft changed on another device. Open Drafts and continue it again.");

export const decodeDraft = (row: DraftRow) =>
  create(ui.ComposerDraftSchema, {
    ...fromBinary(ui.ComposerDraftSchema, row.payload),
    revision: BigInt(row.revision),
  });

export function lockDraft(sql: SqlClient.SqlClient, owner: string, id: string) {
  return Effect.gen(function* () {
    if (!uuid.test(id)) return yield* Effect.fail(new NotFound("Draft not found"));

    const row = (yield* sql<DraftRow>`SELECT * FROM composer_drafts
      WHERE id=${id}::uuid AND owner_user_id=${owner}::uuid AND (expires_at>now() OR sent OR sending_request_id IS NOT NULL) FOR UPDATE`)[0];

    if (!row) return yield* Effect.fail(new NotFound("Draft not found"));

    return row;
  });
}

export function composerDraftStore(sql: SqlClient.SqlClient, owner: string) {
  return {
    save: (request: ui.SaveComposerDraftRequest, remoteTitle?: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const draft = request.draft;

          if (!draft || !uuid.test(draft.id) || !request.mutationId || request.mutationId.length > 200)
            return yield* Effect.fail(new Invalid("Could not save the draft. Retry."));
          // Owner lock bounds count and serializes a device's first save for a target.
          yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${owner}, 9235))`;
          // Lock the target before the draft, matching thread/project deletion and its draft cascade.
          const saved = yield* validateDraft(sql, owner, draft, remoteTitle);
          yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${draft.id}, 9236))`;
          const row = (yield* sql<DraftRow>`SELECT * FROM composer_drafts WHERE id=${draft.id}::uuid FOR UPDATE`)[0];

          if (row && row.owner_user_id !== owner) return yield* Effect.fail(new NotFound("Draft not found"));

          if (row && (row.sent || row.sending_request_id || (row.taken_by ?? row.device_id) !== draft.deviceId))
            return yield* Effect.fail(conflict());

          if (row?.mutation_id === request.mutationId) return decodeDraft(row);

          if (
            BigInt(row?.revision ?? 0) !== request.expectedRevision ||
            row?.sending_request_id ||
            row?.sent ||
            (row && (row.taken_by ?? row.device_id) !== draft.deviceId)
          )
            return yield* Effect.fail(conflict());

          if (!row)
            yield* sql`DELETE FROM composer_drafts WHERE id IN (SELECT id FROM composer_drafts
              WHERE owner_user_id=${owner}::uuid AND expires_at<=now() AND sending_request_id IS NULL AND NOT sent
              ORDER BY updated_at LIMIT 100)`;

          const count =
            (yield* sql<{ n: number }>`SELECT count(*)::int AS n FROM composer_drafts
        WHERE owner_user_id=${owner}::uuid AND NOT sent AND expires_at>now()`)[0]?.n ?? 0;

          if (!row && count >= 100)
            return yield* Effect.fail(new Invalid("You have 100 saved drafts. Remove one, then retry."));

          if (row?.taken_by === saved.deviceId)
            yield* sql`DELETE FROM composer_drafts WHERE owner_user_id=${owner}::uuid AND id<>${saved.id}::uuid
              AND device_id=${saved.deviceId} AND target_key=${draftTargetKey(saved.target!)}
              AND taken_by IS NULL AND NOT sent AND sending_request_id IS NULL`;
          saved.revision = request.expectedRevision + 1n;
          saved.updatedAtMs = BigInt(Date.now());
          const target = saved.target;

          if (!target) return yield* Effect.fail(new Invalid("Draft target is missing"));
          const ref = target.threadId || target.parentThreadId;
          const threadId = ref && !splitId(ref).node ? ref : null;
          yield* sql`INSERT INTO composer_drafts(id,owner_user_id,device_id,target_key,thread_id,target_thread_ref,payload,revision,mutation_id)
        VALUES(${saved.id}::uuid,${owner}::uuid,${saved.deviceId},${draftTargetKey(target)},${threadId}::uuid,
        ${ref},
        ${toBinary(ui.ComposerDraftSchema, saved)},${saved.revision},${request.mutationId})
        ON CONFLICT(id) DO UPDATE SET device_id=excluded.device_id,payload=excluded.payload,revision=excluded.revision,
        target_key=excluded.target_key,thread_id=excluded.thread_id,target_thread_ref=excluded.target_thread_ref,
        mutation_id=excluded.mutation_id,taken_by=NULL,claim_id=NULL,updated_at=now(),expires_at=now()+interval '30 days'`;
          yield* sql`DELETE FROM composer_draft_attachments WHERE draft_id=${saved.id}::uuid`;

          for (const file of saved.content?.attachments ?? [])
            yield* sql`INSERT INTO composer_draft_attachments VALUES(${saved.id}::uuid,${file.id}::uuid)`;

          return saved;
        }),
      ),
    continue: (request: ui.ContinueComposerDraftRequest) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (
            !request.deviceId ||
            request.deviceId.length > 200 ||
            !request.deviceName ||
            request.deviceName.length > 100 ||
            !request.mutationId ||
            request.mutationId.length > 200
          )
            return yield* Effect.fail(new Invalid("Could not continue the draft. Retry."));
          const row = yield* lockDraft(sql, owner, request.id);

          if (row.taken_by === request.deviceId && !row.sent && !row.sending_request_id) return decodeDraft(row);

          if (row.taken_by || row.sent || row.sending_request_id || BigInt(row.revision) !== request.expectedRevision)
            return yield* Effect.fail(conflict());
          const draft = decodeDraft(row);
          draft.revision += 1n;

          // A claim starts a new send identity; an in-flight save from the source
          // can never authorize the source's older send after this fence.
          if (draft.content) draft.content.clientRequestId = crypto.randomUUID();
          draft.takenByDeviceId = request.deviceId;
          draft.takenByDeviceName = request.deviceName;
          yield* sql`UPDATE composer_drafts SET taken_by=${request.deviceId},claim_id=${request.mutationId},
        revision=${draft.revision},payload=${toBinary(ui.ComposerDraftSchema, draft)} WHERE id=${request.id}::uuid`;

          return draft;
        }),
      ),
    remove: (request: ui.DeleteComposerDraftRequest) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const row = yield* lockDraft(sql, owner, request.id);

          // Explicit recovery may discard an uncertain send, including its unsaved receipt.
          const unsavedSend =
            row.device_id === "send-receipt" && row.sending_request_id && request.expectedRevision === 0n;

          if (
            !unsavedSend &&
            (BigInt(row.revision) !== request.expectedRevision || (row.taken_by ?? row.device_id) !== request.deviceId)
          )
            return yield* Effect.fail(conflict());
          yield* sql`DELETE FROM composer_drafts WHERE id=${request.id}::uuid`;
        }),
      ),
  };
}

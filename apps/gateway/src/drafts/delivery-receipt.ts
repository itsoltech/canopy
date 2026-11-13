import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { createHash } from "node:crypto";
import type { GatewayCore } from "../core/core.ts";
import { coreState } from "../core/core-context.ts";
import { conflict, decodeDraft, type DraftRow } from "./store.ts";
import { uuid } from "./content.ts";
import { NotFound } from "../store/errors.ts";

export function prepareDraftDelivery(
  core: GatewayCore,
  id: string,
  revision: bigint,
  target: string,
  kind: string,
  bytes: Uint8Array,
  requestId: string,
  parent = "",
) {
  const attempt = crypto.randomUUID();

  const {
    actions,
    options: { userId },
  } = core[coreState];

  return actions.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Match save/delete lock order: target, then draft. Receipt retries use the same target.
      if (uuid.test(parent))
        yield* sql`SELECT id FROM threads WHERE id=${parent}::uuid AND owner_user_id=${userId}::uuid FOR UPDATE`;

      if (uuid.test(target)) {
        if (kind === "send")
          yield* sql`SELECT id FROM threads WHERE id=${target}::uuid AND owner_user_id=${userId}::uuid FOR UPDATE`;
        else
          yield* sql`SELECT p.id FROM projects p JOIN project_workspaces w ON w.project_id=p.id
            WHERE w.id=${target}::uuid AND p.owner_user_id=${userId}::uuid FOR UPDATE OF p`;
      }

      if (!uuid.test(id)) return yield* Effect.fail(new NotFound("Draft not found"));
      // Serialize a first save against an unsaved send, including qualified remote targets.
      yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 9236))`;

      const row = (yield* sql<
        DraftRow & { delivery_active: boolean }
      >`SELECT *,send_active_until>now() AS delivery_active
        FROM composer_drafts WHERE id=${id}::uuid FOR UPDATE`)[0];

      const hash = createHash("sha256").update(bytes).digest();

      if (row && row.owner_user_id !== userId) return yield* Effect.fail(new NotFound("Draft not found"));

      if (!row) {
        if (revision) return yield* Effect.fail(new NotFound("Draft not found"));
        const ref = kind === "send" ? target : parent;
        yield* sql`INSERT INTO composer_drafts(id,owner_user_id,device_id,target_key,thread_id,target_thread_ref,
            payload,revision,mutation_id,sending_request_id,send_kind,send_request,delivery_request_id,send_attempt_id,send_active_until)
            VALUES(${id}::uuid,${userId}::uuid,'send-receipt',${`${kind}:${target}`},
            ${uuid.test(ref) ? ref : null}::uuid,${ref},${new Uint8Array()},1,${requestId},${requestId},${kind},${hash},
            ${requestId},${attempt}::uuid,now()+interval '5 minutes')`;

        return { sent: false, notify: false, attempt, active: false };
      }

      const draft = decodeDraft(row);

      const unsavedRetry =
        row.device_id === "send-receipt" &&
        row.target_key === `${kind}:${target}` &&
        row.sending_request_id === requestId;

      if (
        (!row.sent &&
          !unsavedRetry &&
          BigInt(row.revision) !== revision &&
          (row.taken_by || draft.content?.clientRequestId !== requestId)) ||
        (!row.sent && !unsavedRetry && (draft.target?.threadId || draft.target?.workspaceId) !== target) ||
        (row.send_kind && row.send_kind !== kind) ||
        (row.send_request && !Buffer.from(row.send_request).equals(hash))
      )
        return yield* Effect.fail(conflict());

      if (row.sent) return { sent: true, notify: false, attempt, active: false };

      if (row.delivery_active) return { sent: false, notify: false, attempt, active: true };
      yield* sql`UPDATE composer_drafts SET sending_request_id=${requestId},
        send_kind=${kind},send_request=${hash},delivery_request_id=${requestId},
        send_attempt_id=${attempt}::uuid,send_active_until=now()+interval '5 minutes' WHERE id=${id}::uuid`;

      return {
        sent: false,
        notify: row.device_id !== "send-receipt" && !row.sending_request_id,
        attempt,
        active: false,
      };
    }),
  );
}

export function settleDraftDelivery(
  core: GatewayCore,
  id: string,
  attempt: string,
  outcome: "sent" | "unknown" | "rejected",
) {
  const {
    actions,
    options: { userId },
  } = core[coreState];

  return actions.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const row = (yield* sql<DraftRow>`SELECT * FROM composer_drafts WHERE id=${id}::uuid
        AND owner_user_id=${userId}::uuid AND send_attempt_id=${attempt}::uuid AND NOT sent FOR UPDATE`)[0];

      if (!row) return false;

      if (outcome === "sent") {
        yield* sql`UPDATE composer_drafts SET sent=true,send_result=NULL,sending_request_id=NULL,send_active_until=NULL,
          payload=${new Uint8Array()},expires_at=now()+interval '30 days' WHERE id=${id}::uuid`;
        yield* sql`DELETE FROM composer_draft_attachments WHERE draft_id=${id}::uuid`;
      } else if (outcome === "unknown") {
        yield* sql`UPDATE composer_drafts SET send_active_until=NULL WHERE id=${id}::uuid`;
      } else if (row.device_id === "send-receipt") {
        yield* sql`DELETE FROM composer_drafts WHERE id=${id}::uuid`;
      } else {
        yield* sql`UPDATE composer_drafts SET sending_request_id=NULL,send_kind=NULL,send_request=NULL,
          delivery_request_id=NULL,send_attempt_id=NULL,send_active_until=NULL WHERE id=${id}::uuid`;
      }

      return outcome === "rejected" && row.device_id !== "send-receipt";
    }),
  );
}

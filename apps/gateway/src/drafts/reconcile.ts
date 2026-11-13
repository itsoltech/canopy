import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { splitId } from "@canopy/domain/computers";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { GatewayCore } from "../core/core.ts";
import { coreState } from "../core/core-context.ts";
import { forward, peerOf } from "../api/routed-home.ts";
import { single } from "../api/routed-context.ts";
import { uuid } from "./content.ts";

/** Never retries a send. Native admission receipts cover every result, including goals. */
export async function reconcileDraftDelivery(
  core: GatewayCore,
  request: ui.GetComposerDraftDeliveryRequest,
  signal: AbortSignal,
) {
  const { runtime, userId } = core[coreState].options;

  if (!request.clientRequestId || (request.id && !uuid.test(request.id)))
    throw new ConnectError("Delivery unavailable", Code.InvalidArgument);

  const receipt = request.id
    ? await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return (yield* sql<{ sent: boolean; active: boolean }>`SELECT sent,send_active_until>now() AS active
      FROM composer_drafts WHERE id=${request.id}::uuid AND owner_user_id=${userId}::uuid
      AND delivery_request_id=${request.clientRequestId} AND (${request.threadId}='' OR target_thread_ref=${request.threadId})`)[0];
        }),
      )
    : undefined;

  if (receipt?.sent) return create(ui.ComposerDraftDeliverySchema, { confirmed: true });
  const node = splitId(request.threadId || request.workspaceId).node;
  let confirmed = false;

  if (node) {
    const method = ui.GatewayService.method.getComposerDraftDelivery;

    const response = await single<ui.ComposerDraftDelivery>(
      forward(
        core,
        await peerOf(core, node),
        method,
        create(ui.GetComposerDraftDeliveryRequestSchema, { ...request, id: "" }),
        signal,
      ),
    );

    confirmed = response.confirmed;
  } else if (!request.threadId) {
    confirmed = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return (
          (yield* sql`SELECT t.id FROM threads t JOIN turns r ON r.thread_id=t.id
            AND r.client_request_id=${request.clientRequestId}
            WHERE t.owner_user_id=${userId}::uuid AND t.creation_request_id=${request.clientRequestId} LIMIT 1`)
            .length > 0
        );
      }),
    );
  } else if (uuid.test(request.threadId)) {
    confirmed = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        const thread =
          (yield* sql`SELECT id FROM threads WHERE id=${request.threadId}::uuid AND owner_user_id=${userId}::uuid`)[0];

        if (!thread) throw new ConnectError("Thread not found", Code.NotFound);

        return (
          (yield* sql`SELECT thread_id AS id FROM thread_message_receipts
        WHERE thread_id=${request.threadId}::uuid AND client_request_id=${request.clientRequestId}
        UNION ALL SELECT id FROM turns WHERE thread_id=${request.threadId}::uuid AND client_request_id=${request.clientRequestId}
        UNION ALL SELECT id FROM turn_steers WHERE thread_id=${request.threadId}::uuid AND client_request_id=${request.clientRequestId} LIMIT 1`)
            .length > 0
        );
      }),
    );
  }

  if (confirmed && receipt)
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const updated =
              yield* sql`UPDATE composer_drafts SET sent=true,sending_request_id=NULL,send_active_until=NULL,
        payload=${new Uint8Array()},expires_at=now()+interval '30 days' WHERE id=${request.id}::uuid
        AND owner_user_id=${userId}::uuid AND delivery_request_id=${request.clientRequestId} AND NOT sent RETURNING id`;

            if (updated.length) yield* sql`DELETE FROM composer_draft_attachments WHERE draft_id=${request.id}::uuid`;
          }),
        );
      }),
    );

  return create(ui.ComposerDraftDeliverySchema, { confirmed, inFlight: !confirmed && Boolean(receipt?.active) });
}

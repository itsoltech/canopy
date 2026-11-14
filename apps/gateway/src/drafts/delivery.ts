import { clone, create, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { GatewayCore } from "../core/core.ts";
import { coreState } from "../core/core-context.ts";
import { draftGuard } from "../api/ui-composer-drafts.ts";
import type { UiHandlers } from "../api/ui-service.ts";
import { notifyDrafts } from "./events.ts";
import { prepareDraftDelivery } from "./delivery-receipt.ts";
import { deliverDraft } from "./deliver.ts";

/** Short claim and settlement transactions surround delivery without holding SQL
 * across remote I/O. Retries retain the message's existing idempotency key. */
export function withDraftDelivery(core: GatewayCore, handlers: UiHandlers): UiHandlers {
  const {
    actions,
    options: { userId },
  } = core[coreState];

  return {
    ...handlers,
    sendMessage: (request, context) =>
      !request.draftId
        ? handlers.sendMessage(request, context)
        : draftGuard(() =>
            deliverDraft(
              core,
              request.draftId,
              () =>
                prepareDraftDelivery(
                  core,
                  request.draftId,
                  request.draftRevision,
                  request.threadId,
                  "send",
                  toBinary(ui.SendMessageRequestSchema, request),
                  request.clientRequestId,
                ),
              async () => {
                const outgoing = clone(ui.SendMessageRequestSchema, request);
                outgoing.draftId = "";
                outgoing.draftRevision = 0n;
                const result = create(ui.SendMessageResponseSchema, await handlers.sendMessage(outgoing, context));

                return result;
              },
            ),
          ),
    createThread: (request, context) =>
      !request.draftId
        ? handlers.createThread(request, context)
        : draftGuard(() =>
            deliverDraft(
              core,
              request.draftId,
              () =>
                prepareDraftDelivery(
                  core,
                  request.draftId,
                  request.draftRevision,
                  request.workspaceId,
                  "create",
                  toBinary(ui.CreateThreadRequestSchema, request),
                  request.clientRequestId,
                  request.parentThreadId,
                ),
              async () => {
                const outgoing = clone(ui.CreateThreadRequestSchema, request);
                outgoing.draftId = "";
                outgoing.draftRevision = 0n;
                const result = create(ui.CreateThreadResponseSchema, await handlers.createThread(outgoing, context));

                return result;
              },
            ),
          ),
    deleteThread: async (request, context) => {
      const result = await handlers.deleteThread(request, context);
      await actions.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          for (const id of result.threadIds ?? [])
            yield* sql`DELETE FROM composer_drafts WHERE owner_user_id=${userId}::uuid AND target_thread_ref=${id}`;
        }),
      );
      notifyDrafts(core);

      return result;
    },
  };
}

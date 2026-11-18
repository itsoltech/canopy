import { clone, create, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import { AsyncChannel } from "@canopy/transport";
import type { GatewayCore } from "../core/core.ts";
import { creationEvent } from "../core/thread-progress.ts";
import { toConnectError } from "../api/ui-errors.ts";
import type { UiHandlers } from "../api/ui-service.ts";
import { draftGuard } from "../api/ui-composer-drafts.ts";
import { deliverDraft } from "./deliver.ts";
import { prepareDraftDelivery } from "./delivery-receipt.ts";

const CREATION_DELIVERY_TIMEOUT_MS = 120_000;

/** Settle the draft before publishing the final thread, as in unary creation. */
export async function* draftCreationProgress(
  core: GatewayCore,
  handlers: UiHandlers,
  request: ui.CreateThreadRequest,
  context: HandlerContext,
) {
  if (!request.draftId) {
    yield* handlers.createThreadWithProgress(request, context);

    return;
  }

  const events = new AsyncChannel<ui.CreateThreadProgress>();
  let failure: ui.CreateThreadProgress | undefined;
  const outgoing = clone(ui.CreateThreadRequestSchema, request);
  outgoing.draftId = "";
  outgoing.draftRevision = 0n;
  // Admission and receipt settlement outlive the subscriber, including routing
  // to a linked home. Keep its authenticated context and bound our own wait.
  const deadline = Date.now() + CREATION_DELIVERY_TIMEOUT_MS;

  const operationContext: HandlerContext = {
    ...context,
    signal: AbortSignal.timeout(CREATION_DELIVERY_TIMEOUT_MS),
    timeoutMs: () => Math.max(0, deadline - Date.now()),
  };

  const stop = () => events.close();
  context.signal.addEventListener("abort", stop, { once: true });

  if (context.signal.aborted) stop();

  void (async () => {
    try {
      const thread = await draftGuard(() =>
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
            let thread: ui.Thread | undefined;

            for await (const value of handlers.createThreadWithProgress(outgoing, operationContext)) {
              const event = create(ui.CreateThreadProgressSchema, value);

              // Preparation precedes first-message admission; failures during start may have committed.
              if (event.status === "failed") {
                failure = event;
                throw new ConnectError(
                  event.detail,
                  event.step === "start_thread" ? Code.Unknown : Code.InvalidArgument,
                );
              }

              if (event.thread) thread = event.thread;
              else events.push(event);
            }

            if (!thread) throw new ConnectError("Send not confirmed. Retry with the same request.", Code.Unknown);

            return thread;
          },
        ),
      );

      events.push(create(ui.CreateThreadProgressSchema, { ...creationEvent("start_thread", "completed"), thread }));
    } catch (error) {
      // An ended stream or lost response can race detached admission. Only an
      // explicit inner failure can establish a definite preparation rejection.
      events.push(failure ?? creationEvent("start_thread", "failed", toConnectError(error).rawMessage));
    } finally {
      events.close();
    }
  })();

  try {
    yield* events;
  } finally {
    context.signal.removeEventListener("abort", stop);
    events.close();
  }
}

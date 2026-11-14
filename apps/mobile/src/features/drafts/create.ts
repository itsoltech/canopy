import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError, type Client } from "@connectrpc/connect";
import type { MobileComposerState } from "./store";
import { uncertainDelivery } from "../threads/pending-message";

export async function createFromDraft(
  api: Client<typeof ui.GatewayService>,
  draft: MobileComposerState | undefined,
  request: ui.CreateThreadRequest,
) {
  if (draft?.preparing)
    throw new ConnectError("Wait for the draft to finish loading, then retry.", Code.FailedPrecondition);
  let outgoing = draft?.pendingCreate;

  try {
    if (draft) draft.preparing = true;

    if (!outgoing) {
      const published = await draft?.publishForSend();
      outgoing = create(ui.CreateThreadRequestSchema, {
        ...request,
        draftId: published?.id ?? "",
        draftRevision: published?.revision ?? 0n,
        clientRequestId: draft?.requestId ?? request.clientRequestId,
      });
      await draft?.beginCreate(outgoing);
    }

    const result = await api.createThread(outgoing, { timeoutMs: 100_000 });
    draft?.clear();

    return result;
  } catch (cause) {
    if (!uncertainDelivery(cause))
      draft?.cancelSend([Code.NotFound, Code.FailedPrecondition].includes(ConnectError.from(cause).code));
    throw cause;
  } finally {
    if (draft) draft.preparing = false;

    if (draft) void draft.reconcile(api);
  }
}

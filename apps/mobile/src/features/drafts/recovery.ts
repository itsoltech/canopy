import type { ui } from "@canopy/contracts";
import type { Client } from "@connectrpc/connect";
import type { MobileComposerState } from "./store";

const running = new WeakMap<MobileComposerState, Promise<void>>();
const timers = new WeakMap<MobileComposerState, ReturnType<typeof setTimeout>>();

export function recoverDraft(draft: MobileComposerState, api: Client<typeof ui.GatewayService>): Promise<void> {
  const active = running.get(draft);

  if (active) return active;
  clearTimeout(timers.get(draft));
  const request = draft.pendingSend || draft.pendingCreate;

  if (!request || draft.preparing || draft.local.closed) return Promise.resolve();
  draft.reconciling = true;
  draft.deliveryChecked = false;
  draft.persist();

  const pending = api
    .getComposerDraftDelivery(
      {
        id: request.draftId,
        threadId: draft.pendingSend?.threadId || "",
        workspaceId: draft.pendingCreate?.workspaceId || "",
        clientRequestId: request.clientRequestId,
      },
      { timeoutMs: 15_000 },
    )
    .then((status) => {
      if (draft.requestId !== request.clientRequestId || draft.preparing) return;

      if (status.confirmed) draft.clear();
      else if (status.inFlight)
        timers.set(
          draft,
          setTimeout(() => void recoverDraft(draft, api), 3000),
        );
      else draft.deliveryChecked = true;
    })
    .catch(() => {
      if (draft.requestId === request.clientRequestId) draft.deliveryChecked = true;
    })
    .finally(() => {
      draft.reconciling = false;
      draft.persist();
      running.delete(draft);
    });

  running.set(draft, pending);

  return pending;
}

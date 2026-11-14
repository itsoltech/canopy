import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { draftDelivery } from "./api.ts";
import type { WebComposerDraft } from "./state.svelte.ts";

const running = new WeakMap<WebComposerDraft, Promise<void>>();
const timers = new WeakMap<WebComposerDraft, ReturnType<typeof setTimeout>>();

export function recoverDraft(draft: WebComposerDraft): Promise<void> {
  const active = running.get(draft);

  if (active) return active;
  clearTimeout(timers.get(draft));

  if (draft.preparing || draft.local.closed || (!draft.pendingSend && !draft.pendingForm)) return Promise.resolve();
  const form = new URLSearchParams(draft.pendingForm);

  const request = create(ui.GetComposerDraftDeliveryRequestSchema, {
    id: draft.pendingSend?.draftId || form.get("draftId") || draft.id,
    threadId: draft.pendingSend?.threadId ?? "",
    workspaceId: form.get("workspaceId") || "",
    clientRequestId: draft.pendingSend?.clientRequestId || form.get("clientRequestId") || draft.requestId,
  });

  draft.reconciling = true;
  draft.deliveryChecked = false;

  const pending = draftDelivery(request)
    .then((status) => {
      if (draft.requestId !== request.clientRequestId || draft.preparing) return;

      if (status.confirmed) draft.clear();
      else if (status.inFlight)
        timers.set(
          draft,
          setTimeout(() => void recoverDraft(draft), 3000),
        );
      else draft.deliveryChecked = true;
    })
    .catch(() => {
      if (draft.requestId === request.clientRequestId) draft.deliveryChecked = true;
    })
    .finally(() => {
      draft.reconciling = false;
      running.delete(draft);
    });

  running.set(draft, pending);

  return pending;
}

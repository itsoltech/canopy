import type { WebComposerDraft } from "./state.svelte.ts";

/** A hung form fetch must eventually expose the pending draft's recovery actions. */
export function watchDraftForm(draft: WebComposerDraft, controller: AbortController, settled: () => void) {
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", finish);
    draft.pendingAbort = undefined;
    draft.preparing = false;
    void draft.reconcile();
    settled();
  };

  const timer = setTimeout(() => controller.abort(), 110_000);
  draft.pendingAbort = () => controller.abort();
  controller.signal.addEventListener("abort", finish, { once: true });

  return finish;
}

/** Keep an unconfirmed creation immutable, including workspace/fork options, across reloads. */
export async function prepareDraftForm(draft: WebComposerDraft, form: FormData) {
  if (draft.pendingForm) {
    const saved = new URLSearchParams(draft.pendingForm);

    for (const key of new Set(form.keys())) form.delete(key);

    for (const [key, value] of saved) form.append(key, value);

    return;
  }

  const published = await draft.publishForSend();

  if (published) {
    form.set("draftId", published.id);
    form.set("draftRevision", published.revision.toString());
  }

  await draft.beginForm(form);
}

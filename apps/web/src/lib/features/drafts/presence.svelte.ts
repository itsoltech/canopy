import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { webDrafts } from "./local.svelte.ts";
import { remoteDrafts } from "./remote.svelte.ts";

/** Observe one target so edits in another composer do not invalidate every sidebar row. */
export function threadDraftPresence(threadId: () => string) {
  let local = $state(false);

  $effect(() => {
    void webDrafts.generation;
    const target = create(ui.ComposerDraftTargetSchema, { threadId: threadId() });
    const store = webDrafts.local;

    const update = () => {
      local = Boolean(store.get(target));
    };

    update();

    return store.subscribeKey(target, update);
  });

  return {
    get current() {
      return local || remoteDrafts.threadIds.includes(threadId());
    },
  };
}

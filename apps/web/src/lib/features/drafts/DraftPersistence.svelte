<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { toJsonString } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import { ComposerSync } from "@canopy/domain/composer-sync";
  import type { WebComposerDraft } from "./state.svelte.ts";
  import { useWorkspace, workspaceVersion } from "#lib/features/workspace/workspace.svelte.ts";

  let { draft }: { draft: WebComposerDraft } = $props();
  const workspace = useWorkspace();

  const sync = new ComposerSync(async () => {
    await untrack(() => draft.publish());
  });

  $effect(() => {
    workspaceVersion();
    const current = draft;

    if (!workspace || workspace().active === "thread") return;
    current.local.flush();

    const timer = setTimeout(() => {
      void current.publish().catch(() => {});
    }, 250);

    return () => clearTimeout(timer);
  });

  $effect(() => {
    const current = draft;
    untrack(() => current.activate());
    void untrack(() => current.reconcile());
  });

  $effect(() => {
    draft.persist();
    const content = toJsonString(ui.ComposerDraftContentSchema, draft.content());
    untrack(() => sync.update(content));
  });

  $effect(() => {
    const current = draft;

    return () => {
      current.local.flush();
      void current.publish().catch(() => {});
    };
  });

  onMount(() => {
    const save = () => {
      draft.local.flush();
      void sync.flush();
    };

    const visibility = () => {
      if (document.hidden) save();
    };

    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", save);
    document.addEventListener("focusout", save);

    return () => {
      sync.cancel();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", save);
      document.removeEventListener("focusout", save);
    };
  });
</script>

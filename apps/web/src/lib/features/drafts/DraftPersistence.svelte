<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { WebComposerDraft } from "./state.svelte.ts";
  import { useWorkspace, workspaceVersion } from "#lib/features/workspace/workspace.svelte.ts";

  let { draft }: { draft: WebComposerDraft } = $props();
  const workspace = useWorkspace();

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
  });

  $effect(() => {
    const current = draft;

    return () => {
      current.local.flush();
      void current.publish().catch(() => {});
    };
  });

  onMount(() => {
    let timer: ReturnType<typeof setTimeout>;

    const save = () => {
      draft.local.flush();
      clearTimeout(timer);
      timer = setTimeout(() => {
        void untrack(() => draft.publish()).catch(() => {});
      }, 250);
    };

    const visibility = () => {
      if (document.hidden) save();
    };

    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", save);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", save);
    };
  });
</script>

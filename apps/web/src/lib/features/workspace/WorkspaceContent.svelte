<script lang="ts">
  import { tick } from "svelte";
  import type { ThreadWorkspace } from "./thread-workspace.svelte.ts";
  import WorkspaceFile from "./WorkspaceFile.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { refreshActivities } from "#lib/shared/activity.ts";

  let { state }: { state: ThreadWorkspace } = $props();

  const selection = $derived.by(() => {
    const tab = state.current;

    return tab ? { ...tab } : undefined;
  });

  const active = $derived(Boolean(selection));

  $effect(() => {
    void active;
    void tick().then(refreshActivities);
  });
</script>

{#if selection}
  {@const tab = selection}
  <div id="workspace-content" role="tabpanel" aria-label={tab.document.path} class="flex min-h-0 flex-1 flex-col">
    {#key tab.document}<WorkspaceFile
        document={tab.document}
        preview={tab.preview}
        onkeep={() => state.view.keep(tab.id)}
        onclose={() => state.close(tab.id)}
      />{/key}
  </div>
{/if}
{#if state.view.error}<Alert tone="error" banner>{state.view.error}</Alert>{/if}

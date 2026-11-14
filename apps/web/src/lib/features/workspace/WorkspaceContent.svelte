<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import { tabPath, type WorkspaceModuleTarget } from "@canopy/domain/workspace-modules";
  import type { ThreadWorkspace } from "./thread-workspace.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { refreshActivities } from "#lib/shared/activity.ts";

  let { state, module }: { state: ThreadWorkspace; module: Snippet<[WorkspaceModuleTarget]> } = $props();

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
  <div id="workspace-content" role="tabpanel" aria-label={tabPath(tab)} class="flex min-h-0 flex-1 flex-col">
    {#if tab.kind === "module"}{#key tab.id}{@render module(
          tab,
        )}{/key}{:else}{#await import("./WorkspaceFile.svelte") then file}{#key tab.document}<file.default
            document={tab.document}
            preview={tab.preview}
            onkeep={() => state.view.keep(tab.id)}
            onclose={() => state.close(tab.id)}
          />{/key}{/await}{/if}
  </div>
{/if}
{#if state.view.error}<Alert tone="error" banner>{state.view.error}</Alert>{/if}

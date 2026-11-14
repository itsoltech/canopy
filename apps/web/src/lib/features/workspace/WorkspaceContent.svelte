<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import { tabPath, type WorkspaceModuleTarget } from "@canopy/domain/workspace-modules";
  import type { ThreadWorkspace } from "./thread-workspace.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
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
          >
            {#snippet tabActions()}
              <MenuItem
                icon="chevron-left"
                disabled={state.view.tabs[0]?.id === tab.id}
                onselect={() => state.view.move(tab.id, -1)}>Move left</MenuItem
              >
              <MenuItem
                icon="chevron-right"
                disabled={state.view.tabs.at(-1)?.id === tab.id}
                onselect={() => state.view.move(tab.id, 1)}>Move right</MenuItem
              >
              <MenuItem icon="x-mark" onselect={() => state.close(tab.id)}>Close tab</MenuItem>
              <MenuItem
                icon="x-circle"
                disabled={state.view.tabs.length <= 1}
                onselect={() => state.closeOthers(tab.id)}>Close other tabs</MenuItem
              >
              <MenuItem icon="check-circle" onselect={() => state.closeSaved()}>Close saved tabs</MenuItem>
            {/snippet}
          </file.default>{/key}{/await}{/if}
  </div>
{/if}
{#if state.view.error}<Alert tone="error" banner>{state.view.error}</Alert>{/if}

<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import MenuSeparator from "#lib/shared/ui/MenuSeparator.svelte";
  import MenuSub from "#lib/shared/ui/MenuSub.svelte";
  import { threadActions } from "../thread-actions.ts";
  import { useThreadActions } from "../thread-actions.svelte.ts";
  import type { ClassValue } from "svelte/elements";
  import { awayReason } from "#lib/features/computers/computers.ts";

  let { thread, class: className }: { thread: ui.Thread; class?: ClassValue } = $props();
  const actions = useThreadActions();
  const away = $derived(thread.nodeId ? awayReason(actions.overview.computer(thread.nodeId)) : undefined);
  const items = $derived(threadActions(thread, actions.overview.project(thread.projectId)?.name ?? "project", actions.settings.sidebar.pinnedThreadIds.includes(thread.id), Boolean(away)));
</script>

<div role="group" aria-label="Thread" class={className}>
{#each items as item, index (item.id)}
  {#if index > 0 && items[index - 1]?.group !== item.group}<MenuSeparator />{/if}
  {#if item.id === "settings"}
    <MenuSub label="Copy" icon="document-duplicate">
      <MenuItem icon="link" onselect={() => void actions.copy(actions.link(thread))}>Link</MenuItem>
      <MenuItem icon="chat-bubble-left" onselect={() => void actions.copy(thread.id)}>Thread ID</MenuItem>
      <MenuItem icon="folder" disabled={!thread.cwd} onselect={() => void actions.copy(thread.cwd)}>Working directory</MenuItem>
    </MenuSub>
  {/if}
  <MenuItem icon={item.icon} disabled={item.disabled} danger={item.id === "delete"} onselect={() => void actions.run(item.id, thread)}>{item.label}</MenuItem>
{/each}
</div>

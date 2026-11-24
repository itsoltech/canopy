<script lang="ts">
  import { canGenerateTitle } from "../title-actions.ts";
  import { browser } from "$app/env";
  import type { ui } from "@canopy/contracts";
  import { snoozeDeadline, snoozePresets } from "@canopy/domain/thread-snooze";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import MenuSeparator from "#lib/shared/ui/MenuSeparator.svelte";
  import MenuSub from "#lib/shared/ui/MenuSub.svelte";
  import { onThisComputer, threadActions, type ThreadActionId } from "../thread-actions.ts";
  import { useThreadActions } from "../thread-actions.svelte.ts";
  import type { ClassValue } from "svelte/elements";
  import { awayReason } from "#lib/features/computers/computers.ts";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";

  /** `omit`: actions already visible where the menu is opened (e.g. the open thread's own header). */
  let {
    thread,
    omit = [],
    class: className,
  }: { thread: ui.Thread; omit?: readonly ThreadActionId[]; class?: ClassValue } = $props();

  const actions = useThreadActions();
  const capabilities = useGatewayCapabilities();
  const away = $derived(thread.nodeId ? awayReason(actions.overview.computer(thread.nodeId)) : undefined);

  const items = $derived(
    threadActions(
      thread,
      actions.overview.project(thread.projectId)?.name ?? "project",
      actions.settings.sidebar.pinnedThreadIds.includes(thread.id),
      Boolean(away),
      capabilities?.linkedComputers ?? false,
      onThisComputer(thread, actions.overview.worker(thread.workerId), capabilities?.ownGateway ?? false),
      actions.overview.worker(thread.workerId)?.os,
    ).filter(
      (item) =>
        !omit.includes(item.id) &&
        (item.id !== "regenerate" || canGenerateTitle(thread, actions.settings.textGeneration)) &&
        !(item.id === "open" && browser && window.canopyDesktop),
    ),
  );
</script>

<div role="group" aria-label="Thread" class={className}>
  {#each items as item, index (item.id)}
    {#if index > 0 && items[index - 1]?.group !== item.group}<MenuSeparator />{/if}
    {#if item.id === "settings"}
      <MenuSub label="Copy" icon="document-duplicate">
        <MenuItem icon="link" onselect={() => void actions.copy(actions.link(thread))}>Link</MenuItem>
        <MenuItem icon="chat-bubble-left" onselect={() => void actions.copy(thread.id)}>Thread ID</MenuItem>
        <MenuItem icon="folder" disabled={!thread.cwd} onselect={() => void actions.copy(thread.cwd)}
          >Working directory</MenuItem
        >
      </MenuSub>
    {/if}
    {#if item.id === "snooze"}
      <MenuSub
        label="Snooze options"
        icon={item.icon}
        disabled={item.disabled}
        primary={{ label: "Snooze for 1 hour", onselect: () => void actions.snoozeUntil(thread, snoozeDeadline(1)) }}
      >
        {#each snoozePresets as preset (preset.value)}
          <MenuItem onselect={() => void actions.snoozeUntil(thread, snoozeDeadline(preset.value))}
            >{preset.label}</MenuItem
          >
        {/each}
        <MenuItem onselect={() => actions.openSnooze(thread, true)}>Choose date and time</MenuItem>
      </MenuSub>
    {:else}
      <MenuItem
        icon={item.icon}
        disabled={item.disabled}
        danger={item.id === "delete"}
        onselect={() => void actions.run(item.id, thread)}>{item.label}</MenuItem
      >
    {/if}
  {/each}
</div>

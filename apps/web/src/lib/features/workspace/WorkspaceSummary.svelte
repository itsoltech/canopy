<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import type { Workspace } from "@canopy/domain/workspace";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import { workspaceVersion } from "./workspace.svelte.ts";

  let {
    view,
    children,
    wide,
    onopen,
    anchor,
  }: { view: Workspace; children: Snippet; wide: boolean; onopen: () => void; anchor?: HTMLElement } = $props();

  let open = $state(false);
  const collapsed = $derived.by(() => (workspaceVersion(), view.panelCollapsed));

  const docked = $derived.by(() => {
    void workspaceVersion();

    return wide && !view.sidebar;
  });

  $effect(() => {
    void wide;
    void view.threadId;
    void workspaceVersion();
    const module = view.sidebar?.module;
    const collapsed = view.panelCollapsed;

    // Opening is transient. A placement change never reopens the summary.
    if (module !== placement.module || collapsed !== placement.collapsed || view.threadId !== placement.threadId)
      open = false;
    placement = { module, collapsed, threadId: view.threadId };
  });

  interface SummaryPlacement {
    module: string | undefined;
    collapsed: boolean;
    threadId: string;
  }

  let placement: SummaryPlacement = { module: undefined, collapsed: false, threadId: "" };

  $effect(() => {
    void wide;
    open = false;
  });

  $effect(() => {
    if (open) onopen();
  });
</script>

{#if docked}
  <IconButton
    icon="information-circle"
    label="Thread details"
    aria-pressed={!collapsed}
    onclick={async () => {
      view.collapsePanel(false);
      await tick();
      document.querySelector<HTMLElement>("[data-workspace-summary]")?.focus();
    }}
  />
{:else if wide}
  <Popover
    bind:open
    {anchor}
    label="Thread details"
    placement="bottom-end"
    offset={8}
    class="workspace-summary w-80 max-w-[calc(100vw-1rem)]"
  >
    {#snippet trigger(props)}<IconButton icon="information-circle" label="Thread details" {...props} />{/snippet}
    <div class="flex items-center justify-between border-b border-divider px-3 py-1">
      <span class="text-sm font-medium">Thread details</span>
      <IconButton icon="x-mark" label="Close thread details" onclick={() => (open = false)} />
    </div>
    <div class="max-h-[calc(100dvh-8rem)] overflow-y-auto p-1">{@render children()}</div>
  </Popover>
{:else}
  <IconButton icon="information-circle" label="Thread details" aria-pressed={open} onclick={() => (open = !open)} />
  <Dialog bind:open title="Thread details" sheet class="workspace-summary">
    {#if open}{@render children()}{/if}
  </Dialog>
{/if}

<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import { tabName, tabPath, tabDirty, tabBusy } from "@canopy/domain/workspace-modules";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import MenuSeparator from "#lib/shared/ui/MenuSeparator.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { workspaceVersion } from "./workspace.svelte.ts";
  import type { ThreadWorkspace } from "./thread-workspace.svelte.ts";
  import WorkspaceClose from "./WorkspaceClose.svelte";
  import WorkspaceCommands from "./WorkspaceCommands.svelte";
  import { usePalette } from "#lib/features/commands/commands.svelte.ts";
  import WorkspaceModulePicker from "./WorkspaceModulePicker.svelte";

  let {
    state: workspace,
    working = false,
    pending = 0,
    actions,
    class: className = "",
  }: {
    state: ThreadWorkspace;
    working?: boolean;
    pending?: number;
    actions?: Snippet;
    class?: string;
  } = $props();

  const view = $derived(workspace.view);
  const palette = usePalette();
  const onclose = (id: string) => workspace.close(id);
  let width = $state(0);
  let root = $state<HTMLDivElement>();
  let focused = $state("thread");
  const revision = $derived(workspaceVersion());

  const tabs = $derived.by(() => {
    void revision;

    return [
      { id: "thread", name: "Thread", path: "Thread", preview: false, dirty: false },
      ...view.tabs.map((tab) => ({
        id: tab.id,
        name: tabName(tab),
        path: tabPath(tab),
        preview: tab.preview,
        dirty: tabDirty(tab),
      })),
    ];
  });

  const active = $derived(tabs.find((tab) => tab.id === view.active) ?? tabs[0]!);

  $effect(() => {
    focused = active.id;
  });

  const count = $derived(Math.max(1, Math.floor((width - 40) / 144)));

  const visible = $derived.by(() => {
    const at = tabs.findIndex((tab) => tab.id === active.id);
    const start = Math.max(0, Math.min(at, tabs.length - count));

    return tabs.slice(start, start + count);
  });

  async function select(id: string) {
    view.select(id);
    await tick();
    root?.querySelector<HTMLButtonElement>(`[data-workspace-tab][aria-selected="true"]`)?.focus();
  }

  function keydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    const buttons = [...(root?.querySelectorAll<HTMLButtonElement>("[data-workspace-tab]") ?? [])];
    const index = buttons.findIndex((button) => button === event.target);

    if (index < 0) return;
    let next: number | undefined;

    if (event.key === "ArrowLeft") next = (index - 1 + buttons.length) % buttons.length;

    if (event.key === "ArrowRight") next = (index + 1) % buttons.length;

    if (event.key === "Home") next = 0;

    if (event.key === "End") next = buttons.length - 1;

    if (next !== undefined) {
      event.preventDefault();
      const button = buttons[next];

      if (button) {
        focused = button.dataset["tabId"] ?? active.id;
        button.focus();
      }
    }

    if (event.key === "Delete" && event.target instanceof HTMLElement) {
      const id = event.target.dataset["tabId"];

      if (id && id !== "thread") {
        event.preventDefault();
        onclose(id);
      }
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={root}
  bind:clientWidth={width}
  class={["flex min-w-0 items-center gap-1", className]}
  onkeydown={keydown}
>
  {#if width >= 230}<div role="tablist" aria-label="Workspace tabs" class="flex min-w-0 flex-1 gap-1">
      {#each visible as tab (tab.id)}
        <div
          class={[
            "flex max-w-56 min-w-0 flex-1 items-center rounded-md",
            tab.id === active.id && "bg-zinc-950/5 dark:bg-white/10",
          ]}
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab.id === active.id}
            aria-controls="workspace-content"
            aria-label={`${tab.name}${tab.preview ? ", Preview" : ""}${tab.dirty ? ", Unsaved changes" : ""}${tab.id === "thread" && pending ? `, ${pending} waiting for you` : ""}`}
            tabindex={tab.id === focused || (!visible.some((entry) => entry.id === focused) && tab.id === active.id)
              ? 0
              : -1}
            data-workspace-tab
            data-tab-id={tab.id}
            class="flex h-9 min-w-0 flex-1 items-center gap-1.5 px-2 text-sm focus-ring"
            onclick={() => view.select(tab.id)}
            ondblclick={() => view.keep(tab.id)}
            {@attach tooltip(tab.path)}
          >
            <span class="truncate" class:italic={tab.preview}>{tab.name}</span>
            {#if tab.id === "thread"}<span class="w-3 shrink-0 text-brand-600 dark:text-brand-400"
                >{pending || (working ? "•" : "")}</span
              >{/if}
          </button>
          {#if tab.id !== "thread"}<button
              type="button"
              aria-label={`Close ${tab.name}`}
              class="flex size-8 shrink-0 items-center justify-center rounded-md text-muted focus-ring hover:bg-zinc-950/5 dark:hover:bg-white/10"
              onclick={() => onclose(tab.id)}
            >
              {#if tab.dirty}<span aria-hidden="true">●</span>{:else}<Icon name="x-mark" />{/if}
            </button>{/if}
        </div>
      {/each}
    </div>{/if}
  <div class="order-2 shrink-0"><WorkspaceModulePicker onselect={(target) => view.openModule(target)} /></div>
  <DropdownMenu label="Switch tab" placement="bottom-end" sheet>
    {#snippet trigger(props)}{#if width < 230}<button
          type="button"
          aria-label={`Switch tab (${tabs.length}), ${active.name}${active.dirty ? ", Unsaved changes" : ""}`}
          class="order-1 flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-zinc-950/5 px-2 text-sm focus-ring dark:bg-white/10"
          {...props}
        >
          <span class="min-w-0 flex-1 truncate" class:italic={active.preview}>{active.name}</span>
          <span aria-hidden="true" class="w-4 shrink-0 text-center text-xs text-muted"
            >{active.dirty ? "●" : tabs.length}</span
          >
          <Icon name="chevron-down" />
        </button>{:else}<IconButton
          icon="chevron-down"
          class="order-3"
          label={`Switch tab (${tabs.length})`}
          {...props}
        />{/if}{/snippet}
    {#each tabs as tab (tab.id)}<MenuItem
        current={tab.id === active.id}
        description={tab.id === "thread" ? undefined : tab.path}
        onselect={() => void select(tab.id)}
        >{tab.name}{tab.dirty ? " · Unsaved changes" : tab.preview ? " · Preview" : ""}</MenuItem
      >{/each}
    {#if active.id !== "thread"}
      <MenuSeparator />
      <MenuItem onselect={() => view.keep(active.id)}>Keep tab</MenuItem>
      <MenuItem disabled={view.tabs[0]?.id === active.id} onselect={() => view.move(active.id, -1)}>Move left</MenuItem>
      <MenuItem disabled={view.tabs.at(-1)?.id === active.id} onselect={() => view.move(active.id, 1)}
        >Move right</MenuItem
      >
      <MenuItem onselect={() => onclose(active.id)}>Close tab</MenuItem>
    {/if}
    <MenuItem disabled={tabs.length <= 1} onselect={() => workspace.closeOthers(active.id)}>Close other tabs</MenuItem>
    <MenuItem
      onselect={() => {
        for (const tab of view.tabs.filter((tab) => !tabDirty(tab) && !tabBusy(tab))) view.close(tab.id);
      }}>Close saved tabs</MenuItem
    >
    {#if palette}<MenuSeparator /><MenuItem onselect={() => palette.show()}>Search and commands</MenuItem>{/if}
    {#if actions}<MenuSeparator />{@render actions()}{/if}
  </DropdownMenu>
</div>

<WorkspaceCommands {workspace} />
<WorkspaceClose
  tabs={workspace.closing}
  oncancel={() => (workspace.closing = [])}
  onclose={(save) => workspace.confirmClose(save)}
/>

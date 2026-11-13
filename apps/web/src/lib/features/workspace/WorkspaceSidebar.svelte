<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import type { Workspace } from "@canopy/domain/workspace";
  import { workspaceModules, workspaceModule, type WorkspaceModuleTarget } from "@canopy/domain/workspace-modules";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import MenuSeparator from "#lib/shared/ui/MenuSeparator.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import WorkspaceModulePicker from "./WorkspaceModulePicker.svelte";
  import { workspaceVersion } from "./workspace.svelte.ts";
  import WorkspaceSurface from "./WorkspaceSurface.svelte";
  import { workspacePanel } from "./workspace-motion.ts";

  let {
    view,
    summary,
    module,
    sheet = $bindable(false),
    wide,
  }: {
    view: Workspace;
    summary: Snippet;
    module: Snippet<[WorkspaceModuleTarget, boolean]>;
    sheet?: boolean;
    wide: boolean;
  } = $props();

  const selection = $derived.by(() => {
    void workspaceVersion();

    return view.sidebar;
  });

  const collapsed = $derived.by(() => (workspaceVersion(), view.panelCollapsed));
  const active = $derived(selection && workspaceModule(selection.module));
  let root = $state<HTMLElement>();

  $effect(() => {
    void wide;
    sheet = false;
  });

  function toggle(target: WorkspaceModuleTarget) {
    view.setSidebar(selection?.module === target.module ? undefined : target);
  }

  async function collapse() {
    if (wide) {
      view.collapsePanel(true);
      await tick();
      document.querySelector<HTMLElement>('button[aria-label="Show panel"]')?.focus();
    }

    sheet = false;
  }
</script>

{#snippet header()}
  <div
    class="flex h-12 shrink-0 items-center gap-1 border-b border-divider px-2"
    data-window-end
    style:--window-end-inset="max(0.5rem, calc(var(--window-controls-width, 0px) - 44px))"
  >
    <DropdownMenu label="Sidebar module" placement="bottom-start" sheet>
      {#snippet trigger(props)}<button
          type="button"
          aria-label={active?.label ?? "Thread details"}
          title={active?.label ?? "Thread details"}
          class="flex h-9 min-w-0 items-center gap-1.5 rounded-md bg-zinc-950/5 px-2 text-sm focus-ring dark:bg-white/10"
          {...props}
        >
          <Icon name={active?.icon ?? "information-circle"} />
          <span class="truncate">{active?.label ?? "Thread details"}</span>
          <Icon name="chevron-down" />
        </button>{/snippet}
      {#each workspaceModules as entry (entry.id)}<MenuItem
          icon={entry.icon}
          current={selection?.module === entry.id}
          onselect={() => view.setSidebar({ module: entry.id, resource: "" })}>{entry.label}</MenuItem
        >{/each}
      {#if selection}<MenuSeparator /><MenuItem onselect={() => view.setSidebar()}>Close module</MenuItem>{/if}
    </DropdownMenu>
    <WorkspaceModulePicker sidebar onselect={(target) => view.setSidebar(target)} />
    <span class="flex-1"></span>
    <div class="w-8 shrink-0">
      {#if selection}<IconButton
          icon="arrow-top-right-on-square"
          label="Open in tab"
          onclick={() => {
            view.openModule(selection);
            sheet = false;
          }}
        />{/if}
    </div>
    <IconButton icon="panel-right" label={wide ? "Collapse panel" : "Close modules"} onclick={() => void collapse()} />
  </div>
{/snippet}

{#if wide}
  <aside
    bind:this={root}
    aria-label="Workspace sidebar"
    class="relative flex min-h-0 min-w-0 justify-end border-l border-divider"
  >
    {#if !collapsed}<div
        class="absolute inset-y-0 right-[44px] z-10 flex min-h-0 w-(--workspace-panel-content-width) min-w-0 flex-col bg-surface"
        inert={collapsed}
        transition:workspacePanel={false}
      >
        {@render header()}
        <WorkspaceSurface
          target={selection}
          onreplace={() =>
            root?.querySelector<HTMLElement>("[aria-pressed=true], [aria-label=Modules] button")?.focus()}
        >
          {#snippet children(shown)}{#if shown}{@render module(shown, false)}{:else}{@render summary()}{/if}{/snippet}
        </WorkspaceSurface>
      </div>{/if}
    <div
      class="workspace-rail flex w-[44px] shrink-0 flex-col items-center gap-1 border-l border-divider py-2"
      aria-label="Modules"
    >
      {#each workspaceModules as entry (entry.id)}<IconButton
          icon={entry.icon}
          label={entry.label}
          aria-pressed={selection?.module === entry.id}
          onclick={() => toggle({ module: entry.id, resource: "" })}
        />{/each}
    </div>
  </aside>
{:else}
  <Dialog bind:open={sheet} title="Modules" bare sheet>
    {#if sheet}
      {@render header()}
      <div class="min-h-0 overflow-auto p-2">
        {#if selection}{@render module(selection, false)}{:else}<div class="grid gap-1">
            {#each workspaceModules as entry (entry.id)}<button
                type="button"
                class="flex min-h-11 items-center gap-3 rounded-lg px-3 text-left text-sm focus-ring hover:bg-zinc-950/5 dark:hover:bg-white/10"
                onclick={() => view.setSidebar({ module: entry.id, resource: "" })}
                ><Icon name={entry.icon} />{entry.label}</button
              >{/each}
          </div>{/if}
      </div>
    {/if}
  </Dialog>
{/if}

<style>
  :global(html:is([data-canopy-platform="linux"], [data-canopy-platform="win32"]):not([data-window-fullscreen]))
    .workspace-rail {
    padding-top: 3.5rem;
  }
</style>

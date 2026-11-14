<script lang="ts">
  import { tick } from "svelte";
  import { tabName, tabPath, tabDirty } from "@canopy/domain/workspace-modules";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { workspaceVersion } from "./workspace.svelte.ts";
  import type { ThreadWorkspace } from "./thread-workspace.svelte.ts";
  import WorkspaceClose from "./WorkspaceClose.svelte";
  import WorkspaceCommands from "./WorkspaceCommands.svelte";

  let {
    state: workspace,
    working = false,
    pending = 0,
    class: className = "",
  }: {
    state: ThreadWorkspace;
    working?: boolean;
    pending?: number;
    class?: string;
  } = $props();

  const view = $derived(workspace.view);
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

  let rem = $state(16);

  // Reserve Thread and the overflow chip before adding files at their maximum width (12 rem).
  // The active file stays visible even in a narrower slot, where its name truncates.
  const room = $derived(Math.max(0, Math.floor((width / rem - 5.25 - 3.75) / 12.125)));

  const shown = $derived.by(() => {
    const files = tabs.slice(1);
    const at = files.findIndex((tab) => tab.id === active.id);
    const count = Math.max(at >= 0 ? 1 : 0, Math.min(room, files.length));
    const start = Math.max(0, Math.min(at, files.length - count));

    return files.slice(start, start + count);
  });

  const visible = $derived([tabs[0]!, ...shown]);
  const hidden = $derived(tabs.slice(1).filter((tab) => !shown.includes(tab)));

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
  class={["relative flex h-full min-w-0 items-center gap-1", className]}
  onkeydown={keydown}
>
  <span class="pointer-events-none invisible absolute w-[1rem]" bind:clientWidth={rem}></span>
  <div role="tablist" aria-label="Workspace tabs" class="flex h-full min-w-0">
    {#each visible as tab (tab.id)}
      <div
        class={[
          "workspace-tab relative isolate flex min-w-0 items-center",
          // Thread keeps its slot; every file, including the active one, must fit the available space.
          tab.id === "thread" ? "shrink-0" : tab.id === active.id ? "max-w-48 shrink" : "max-w-48 shrink-100000",
        ]}
        data-active={tab.id === active.id}
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
          class={[
            "flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-t-lg text-sm focus-ring -outline-offset-2",
            tab.id === "thread" ? "px-3" : "pl-3",
            tab.id === active.id ? "text-zinc-950 dark:text-white" : "text-muted",
          ]}
          onclick={() => view.select(tab.id)}
          ondblclick={() => view.keep(tab.id)}
          {@attach tooltip(tab.path)}
        >
          <span class={["truncate", tab.preview && "pr-0.5 italic"]}>{tab.name}</span>
          {#if tab.id === "thread" && (pending || working)}<span
              class="shrink-0 text-brand-600 tabular-nums dark:text-brand-400">{pending || "•"}</span
            >{/if}
        </button>
        {#if tab.id !== "thread"}<button
            type="button"
            aria-label={`Close ${tab.name}`}
            class="workspace-tab-close mr-1 flex size-6 shrink-0 items-center justify-center rounded text-muted focus-ring hover:bg-zinc-950/5 hover:text-ink dark:hover:bg-white/10"
            data-dirty={tab.dirty}
            onclick={() => onclose(tab.id)}
          >
            {#if tab.dirty}<span aria-hidden="true">●</span>{:else}<Icon name="x-mark" />{/if}
          </button>{/if}
      </div>
    {/each}
  </div>
  {#if hidden.length}
    <DropdownMenu label="More tabs" placement="bottom-start" sheet class="max-w-80">
      {#snippet trigger(props)}<button
          type="button"
          aria-label={`${hidden.length} more ${hidden.length === 1 ? "tab" : "tabs"}${hidden.some((tab) => tab.dirty) ? ", Unsaved changes" : ""}`}
          class="workspace-overflow flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-sm text-muted tabular-nums focus-ring hover:bg-hover sm:text-xs"
          {...props}
          >+{hidden.length}{#if hidden.some((tab) => tab.dirty)}<span aria-hidden="true">●</span>{/if}</button
        >{/snippet}
      {#each hidden as tab (tab.id)}<MenuItem description={tab.path} onselect={() => void select(tab.id)}
          >{tab.name}{tab.dirty ? " · Unsaved changes" : tab.preview ? " · Preview" : ""}</MenuItem
        >{/each}
    </DropdownMenu>
  {/if}
</div>

<WorkspaceCommands {workspace} />
<WorkspaceClose
  tabs={workspace.closing}
  oncancel={() => (workspace.closing = [])}
  onclose={(save) => workspace.confirmClose(save)}
/>

<style>
  /* Only the active tab is a surface: it rises from the chrome and continues into the content below,
     so its bottom corners curve outwards over the chrome (no border, gap or shadow at the join).
     Inactive tabs are text on the chrome; hover shows a quiet inset pill, and a hairline separates
     two inactive neighbours only. */
  .workspace-tab {
    --tab-radius: 0.5rem;
  }
  .workspace-tab::before,
  .workspace-tab::after {
    position: absolute;
    z-index: -1;
    content: "";
    pointer-events: none;
  }
  .workspace-tab[data-active="false"]::before {
    inset: 0.3125rem 0.125rem;
    border-radius: 0.375rem;
    background: var(--color-hover);
    opacity: 0;
    transition: opacity var(--duration-fast) var(--ease-smooth-out);
  }
  .workspace-tab[data-active="false"]:has(button:hover, button:focus-visible)::before {
    opacity: 1;
  }
  .workspace-tab[data-active="true"] {
    border-radius: var(--tab-radius) var(--tab-radius) 0 0;
    background: var(--color-surface);
  }
  /* Reverse corners: a 1 px soft edge keeps the curve free of stair-steps at DPR 1 and 2. */
  .workspace-tab[data-active="true"]::before,
  .workspace-tab[data-active="true"]::after {
    bottom: 0;
    width: var(--tab-radius);
    height: var(--tab-radius);
    --corner: transparent calc(var(--tab-radius) - 0.5px), var(--color-surface) calc(var(--tab-radius) + 0.5px);
  }
  .workspace-tab[data-active="true"]::before {
    right: 100%;
    background: radial-gradient(circle at top left, var(--corner));
  }
  .workspace-tab[data-active="true"]::after {
    left: 100%;
    background: radial-gradient(circle at top right, var(--corner));
  }
  .workspace-tab[data-active="false"] + .workspace-tab[data-active="false"] {
    background: linear-gradient(var(--color-divider), var(--color-divider)) left center / 1px 1rem no-repeat;
  }
  .workspace-tab[data-active="false"]:has(button:hover, button:focus-visible),
  .workspace-tab[data-active="false"]:has(button:hover, button:focus-visible) + .workspace-tab {
    background-size: 1px 0;
  }
  .workspace-tab button[role="tab"] {
    transition: color var(--duration-fast) var(--ease-smooth-out);
  }
  .workspace-tab[data-active="false"] button[role="tab"]:hover {
    color: var(--color-ink);
  }
  .workspace-tab-close {
    transition: opacity var(--duration-quick) var(--ease-in-out);
  }
  @media (hover: hover) and (pointer: fine) {
    .workspace-tab[data-active="false"]:not(:hover, :focus-within) .workspace-tab-close:not([data-dirty="true"]) {
      opacity: 0;
    }
  }
  .workspace-overflow {
    margin-inline-start: 0.5rem;
    margin-inline-end: 0.25rem;
  }
  @media (prefers-reduced-motion: reduce) {
    .workspace-tab::before,
    .workspace-tab button[role="tab"],
    .workspace-tab-close {
      transition: none;
    }
  }
</style>

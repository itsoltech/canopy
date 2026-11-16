<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import type { Workspace } from "@canopy/domain/workspace";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { getDiffState } from "./diff-state.svelte.ts";
  import { diffFileStatus } from "./diff-layout.ts";

  let {
    view,
    onopen,
    active = true,
    class: className,
  }: {
    view: Workspace;
    onopen?: () => void;
    active?: boolean;
    class?: ClassValue;
  } = $props();

  const diff = $derived(getDiffState(view));
  let scroller = $state<HTMLDivElement>();
  let height = $state(400);
  let rowHeight = $state(40);
  let top = $state(0);
  let focused = $state(0);
  const first = $derived(Math.max(0, Math.floor(top / rowHeight) - 6));
  const count = $derived(Math.min(100, Math.ceil(height / rowHeight) + 12));
  const visible = $derived(diff.files.slice(first, first + count));

  $effect(() => {
    const current = diff;

    if (active) untrack(() => current.ensure());
  });

  async function focus(index: number) {
    if (!scroller) return;
    focused = Math.max(0, Math.min(diff.files.length - 1, index));
    const position = focused * rowHeight;

    if (position < scroller.scrollTop) scroller.scrollTop = position;
    else if (position + rowHeight > scroller.scrollTop + height) scroller.scrollTop = position + rowHeight - height;
    top = scroller.scrollTop;
    await tick();
    scroller.querySelector<HTMLButtonElement>(`[data-diff-file-index="${focused}"]`)?.focus();
  }

  function keydown(event: KeyboardEvent, index: number) {
    let next = index;

    if (event.key === "ArrowDown") next++;
    else if (event.key === "ArrowUp") next--;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = diff.files.length - 1;
    else return;
    event.preventDefault();
    void focus(next);
  }
</script>

<div class={["density-chrome flex h-full min-h-0 min-w-0 flex-col", className]}>
  <span class="invisible absolute h-9 pointer-coarse:h-12" bind:clientHeight={rowHeight}></span>
  <div class="flex h-12 shrink-0 items-center gap-2 border-b border-divider pr-2 pl-3" data-window-end>
    <p class="min-w-0 flex-1 truncate text-base font-medium sm:text-sm">Changed files</p>
    <span class="shrink-0 text-sm text-muted tabular-nums sm:text-xs">{diff.files.length.toLocaleString()}</span>
    <span class="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
      {#if diff.loading}<Spinner />{/if}
    </span>
    <IconButton
      icon="arrow-path"
      label="Refresh changes"
      disabled={!active || diff.loading}
      onclick={() => diff.refresh()}
    />
  </div>
  {#if diff.error}
    <p role="alert" class="px-3 py-3 text-sm text-rose-700 sm:text-xs dark:text-rose-300">{diff.error}</p>
  {/if}
  <div
    bind:this={scroller}
    bind:clientHeight={height}
    class="min-h-0 flex-1 scroll-stable overflow-auto"
    onscroll={() => (top = scroller?.scrollTop ?? 0)}
  >
    {#if !diff.files.length}
      <div class="px-3 py-4 text-base text-muted sm:text-sm" role="status">
        {#if diff.loading}Loading changes…{:else if diff.loaded && !diff.error}No local changes{:else if !active}Connect
          the worker to load changes.{/if}
      </div>
    {:else}
      <div class="relative min-w-0" style:height={`${diff.files.length * rowHeight}px`}>
        {#each visible as file, offset (file.path)}
          {@const index = first + offset}
          <button
            type="button"
            data-diff-file-index={index}
            tabindex={index === focused ? 0 : -1}
            aria-current={diff.activePath === file.path ? "true" : undefined}
            class={[
              "absolute inset-x-0 flex min-w-0 items-center gap-2 px-3 text-left text-base focus-ring focus-visible:-outline-offset-2 sm:text-sm",
              diff.activePath === file.path
                ? "bg-zinc-950/5 dark:bg-white/8"
                : "hover:bg-zinc-950/3 dark:hover:bg-white/5",
            ]}
            style:top={`${index * rowHeight}px`}
            style:height={`${rowHeight}px`}
            title={`${file.oldPath ? `${file.oldPath} → ` : ""}${file.path} · ${diffFileStatus(file.status)}`}
            onfocus={() => (focused = index)}
            onkeydown={(event) => keydown(event, index)}
            onclick={() => {
              diff.open(file.path);
              onopen?.();
            }}
          >
            <span class="w-4 shrink-0 text-center font-mono text-sm text-muted" aria-label={diffFileStatus(file.status)}
              >{file.status}</span
            >
            <span class="min-w-0 flex-1 truncate">{file.path}</span>
            <span class="flex shrink-0 gap-1.5 font-mono text-sm tabular-nums sm:text-xs">
              {#if file.binary}<span class="text-muted">Binary</span>{:else}
                <span class="text-emerald-700 dark:text-emerald-300">+{file.additions.toLocaleString()}</span>
                <span class="text-rose-700 dark:text-rose-300">−{file.deletions.toLocaleString()}</span>
              {/if}
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>

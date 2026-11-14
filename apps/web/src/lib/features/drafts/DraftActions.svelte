<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { ui } from "@canopy/contracts";
  import { hasComposerContent, matchesComposerTarget } from "@canopy/domain/composer-drafts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { remoteDrafts } from "./remote.svelte.ts";
  import { webDrafts } from "./local.svelte.ts";
  import { deleteDraft } from "./api.ts";
  import type { WebComposerDraft } from "./state.svelte.ts";
  import DraftRow from "./DraftRow.svelte";

  let {
    draft,
    disabled = false,
    class: className = "",
  }: {
    draft: WebComposerDraft;
    disabled?: boolean;
    class?: string;
  } = $props();

  let open = $state(false);
  let selected = $state("");
  let busy = $state(false);
  let error = $state("");
  let root = $state<HTMLDivElement>();
  const id = $props.id();

  let rows = $derived(
    remoteDrafts.rows.filter((row) => matchesComposerTarget(row.target, draft.targetKey) && row.id !== draft.id),
  );

  $effect(() => {
    if (webDrafts.ready) void remoteDrafts.load().catch(() => {});
  });

  $effect(() => {
    if (!rows.length) {
      open = false;
      selected = "";
    }
  });

  onMount(() => remoteDrafts.subscribe());

  $effect(() => {
    if (rows.some((row) => row.updatedAtMs > draft.publishedAtMs)) untrack(() => (draft.moved = ""));
  });

  function close() {
    open = false;
    selected = "";
  }

  function outside(event: PointerEvent) {
    if (event.target instanceof Node && !root?.contains(event.target)) close();
  }

  async function take(row: ui.ComposerDraft, replace = false) {
    if (disabled || draft.locked || !matchesComposerTarget(row.target, draft.targetKey)) return;
    busy = true;
    error = "";

    try {
      await draft.take(row, replace);
      close();
      remoteDrafts.invalidate();
      await remoteDrafts.load();
    } catch {
      error = "Could not take over this draft. Select it to retry.";
    } finally {
      busy = false;
    }
  }

  async function discard(row: ui.ComposerDraft) {
    busy = true;
    error = "";

    try {
      await deleteDraft(row, row.takenByDeviceId || row.deviceId);
      remoteDrafts.invalidate();
      await remoteDrafts.load();
    } catch {
      error = "Could not discard this draft. Try again.";
    } finally {
      busy = false;
    }
  }
</script>

<svelte:window
  onpointerdown={outside}
  onkeydown={(event) => {
    if (open && event.key === "Escape") {
      event.preventDefault();
      close();
      root?.querySelector<HTMLButtonElement>("[aria-expanded]")?.focus();
    }
  }}
/>

{#if rows.length}
  <div
    bind:this={root}
    class={["pointer-events-none absolute inset-x-0 bottom-full z-30 flex justify-end px-3", className]}
  >
    <section
      class={[
        "pointer-events-auto -mb-px overflow-hidden rounded-t-xl border border-b-0 border-zinc-950/10 bg-surface text-sm/5 text-zinc-600 sm:text-xs/5 dark:border-white/10 dark:text-zinc-300",
        open ? "w-full" : "w-auto",
      ]}
      aria-label="Drafts"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onclick={() => {
          open = !open;
          selected = "";
        }}
        class="flex min-h-8 w-full items-center gap-2 px-3 text-left focus-ring hover:bg-zinc-950/5 dark:hover:bg-white/5"
      >
        <Icon name="document-text" size="sm" /><span class="flex-1">Drafts</span>
        <span class="text-accent tabular-nums">{rows.length}</span>
        <span class="draft-chevron" class:expanded={open}><Icon name="chevron-down" size="sm" /></span>
      </button>
      <div class="draft-fold" class:expanded={open} inert={!open}>
        <div class="min-h-0 overflow-hidden">
          <div {id} class="max-h-[min(40dvh,16rem)] overflow-y-auto overscroll-contain px-1 pb-1">
            {#each rows as row (row.id)}
              <DraftRow
                {row}
                selected={selected === row.id}
                disabled={disabled || busy || draft.locked}
                onselect={() => {
                  if (hasComposerContent(draft.content())) selected = selected === row.id ? "" : row.id;
                  else void take(row);
                }}
                ontake={(replace) => void take(row, replace)}
                ondiscard={() => void discard(row)}
              />
            {/each}
            {#if error}<p role="status" class="px-2 py-1 text-rose-600 dark:text-rose-400">{error}</p>{/if}
          </div>
        </div>
      </div>
    </section>
  </div>
{/if}

<style>
  .draft-fold {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows var(--duration-fast) var(--ease-smooth-out);
  }
  .draft-fold.expanded {
    grid-template-rows: 1fr;
  }
  .draft-chevron {
    transform: scaleY(-1);
    display: inline-flex;
    transition: transform var(--duration-fast) var(--ease-smooth-out);
  }
  .draft-chevron.expanded {
    transform: scaleY(1);
  }
  @media (prefers-reduced-motion: reduce) {
    .draft-fold,
    .draft-chevron {
      transition: none;
    }
  }
</style>

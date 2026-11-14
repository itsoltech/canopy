<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { ui } from "@canopy/contracts";
  import { hasComposerContent, matchesComposerTarget } from "@canopy/domain/composer-drafts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import { remoteDrafts } from "./remote.svelte.ts";
  import { webDrafts } from "./local.svelte.ts";
  import { deleteDraft } from "./api.ts";
  import type { WebComposerDraft } from "./state.svelte.ts";
  import DraftRow from "./DraftRow.svelte";

  let {
    draft,
    disabled = false,
    class: className = "",
  }: { draft: WebComposerDraft; disabled?: boolean; class?: string } = $props();

  let open = $state(false);
  let selected = $state("");
  let busy = $state(false);
  let error = $state("");
  let anchor = $state<HTMLDivElement>();

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

  $effect(() => {
    if (rows.some((row) => row.updatedAtMs > draft.publishedAtMs)) untrack(() => (draft.moved = ""));
  });

  onMount(() => remoteDrafts.subscribe());

  async function take(row: ui.ComposerDraft, replace = false) {
    if (disabled || draft.locked || !matchesComposerTarget(row.target, draft.targetKey)) return;
    busy = true;
    error = "";

    try {
      await draft.take(row, replace);
      open = false;
      selected = "";
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

{#if rows.length}
  <div bind:this={anchor} class={["relative h-8 w-full", className]}>
    <Popover
      bind:open
      {anchor}
      label="Drafts"
      role="none"
      placement="top-start"
      offset={-33}
      followMotion
      class="drafts-attached"
      maxHeight="min(40dvh,16rem)"
      onclose={() => (selected = "")}
    >
      {#snippet trigger(props)}
        <div class="flex h-8 justify-end pr-3" class:invisible={open}>
          <button
            type="button"
            {...props}
            class="relative -bottom-px flex h-8 items-center gap-2 rounded-t-xl border border-b-0 border-zinc-950/10 bg-surface px-3 text-sm/5 text-zinc-600 focus-ring sm:text-xs/5 dark:border-white/10 dark:text-zinc-300"
          >
            <Icon name="document-text" size="sm" /><span>Drafts</span><span class="text-accent tabular-nums"
              >{rows.length}</span
            ><span class="-scale-y-100"><Icon name="chevron-down" size="sm" /></span>
          </button>
        </div>
      {/snippet}
      <section aria-label="Drafts" class="text-sm/5 text-zinc-600 sm:text-xs/5 dark:text-zinc-300">
        <button
          type="button"
          aria-expanded="true"
          onclick={() => (open = false)}
          class="flex min-h-8 w-full items-center gap-2 px-3 text-left focus-ring hover:bg-zinc-950/5 dark:hover:bg-white/5"
        >
          <Icon name="document-text" size="sm" /><span class="flex-1">Drafts</span><span
            class="text-accent tabular-nums">{rows.length}</span
          ><Icon name="chevron-down" size="sm" />
        </button>
        <div class="px-1 pb-1">
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
      </section>
    </Popover>
  </div>
{/if}

<style>
  :global(.drafts-attached) {
    width: var(--float-anchor-width);
    border: 1px solid var(--theme-border);
    border-bottom: 0;
    border-radius: 12px 12px 0 0;
    box-shadow: none;
  }
</style>

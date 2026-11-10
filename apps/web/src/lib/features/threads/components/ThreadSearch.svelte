<script lang="ts">
  import { untrack } from "svelte";
  import type { ThreadState } from "../thread-state.svelte.ts";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import SearchField from "#lib/shared/ui/SearchField.svelte";
  import Button from "#lib/shared/ui/Button.svelte";

  let {
    open = $bindable(false),
    view,
    reveal,
  }: { open?: boolean; view: ThreadState; reveal: (turnId: string, itemId?: string) => Promise<void> } = $props();

  let query = $state("");
  let searched = $state("");
  const needle = $derived(query.trim().toLowerCase());

  const matches = $derived.by(() => {
    if (!needle) return [];

    const inputs = view.turns.map((turn) => ({
      key: `turn:${turn.id}`,
      turnId: turn.id,
      itemId: "",
      text: turn.messageText || turn.inputText,
    }));

    const answers = view.entries.flatMap((entry) =>
      entry.item.content.case === "agentMessage"
        ? [{ key: entry.id, turnId: entry.turnId, itemId: entry.id, text: entry.item.content.value.text }]
        : [],
    );

    return [...inputs, ...answers].filter((hit) => hit.text.toLowerCase().includes(needle));
  });

  $effect(() => {
    const key = `${needle}:${view.turns[0]?.id ?? ""}`;

    if (!open || !needle || !view.hasMore || view.history.loading || searched === key) return;
    searched = key;
    untrack(() => void view.history.load());
  });
</script>

<Dialog bind:open title="Search thread">
  <div class="space-y-3">
    <SearchField label="Search messages" bind:value={query} data-autofocus />
    {#if needle}
      <p class="text-sm text-zinc-500 dark:text-zinc-400" aria-live="polite">
        {#if view.history.loading}Searching earlier messages…{:else if view.hasMore}Search includes loaded messages.{:else}{matches.length}
          results{/if}
      </p>
      {#if view.hasMore && !view.history.loading}
        <Button size="sm" onclick={() => void view.history.load()}>Search earlier messages</Button>
      {/if}
      {#if view.history.error}<p role="status" class="text-sm text-red-600 dark:text-red-400">
          {view.history.error}
        </p>{/if}
      <div class="max-h-80 scroll-stable space-y-1 overflow-y-auto">
        {#each matches as hit (hit.key)}
          <button
            type="button"
            class="w-full rounded-lg px-3 py-2 text-left text-sm text-zinc-950 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-brand-500 dark:text-white dark:hover:bg-white/5"
            onclick={() => {
              open = false;
              void reveal(hit.turnId, hit.itemId);
            }}
          >
            <span class="line-clamp-3 whitespace-pre-wrap">{hit.text}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</Dialog>

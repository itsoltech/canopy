<script lang="ts">
  import { page } from "$app/state";
  import { ThreadState } from "#lib/features/threads/thread-state.svelte.ts";
  import Composer from "#lib/features/threads/components/Composer.svelte";
  import InteractionCard from "#lib/features/threads/components/InteractionCard.svelte";
  import ItemView from "#lib/features/threads/components/ItemView.svelte";
  import StatusBadge from "#lib/shared/ui/StatusBadge.svelte";

  const threadId = $derived(page.params.threadId ?? "");
  const view = new ThreadState();
  $effect(() => view.connect(threadId));

  let bottom = $state<HTMLElement>();
  $effect(() => {
    // Follow new entries while the user is at the end of the timeline.
    void view.entries.length;
    bottom?.scrollIntoView({ block: "end" });
  });
</script>

<div class="flex h-full flex-col">
  <header class="flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-3">
    <div class="min-w-0">
      <h1 class="truncate font-semibold">{view.thread?.title ?? "…"}</h1>
      <p class="truncate text-xs text-slate-500">
        <code>{view.thread?.cwd}</code> · Codex{view.thread?.providerProfileId ? ` via ${view.thread.providerProfileId}` : ""}{view.thread?.model ? ` · ${view.thread.model}` : ""}
      </p>
    </div>
    <div class="flex items-center gap-2">
      {#if !view.live}<span class="text-xs text-slate-500">reconnecting…</span>{/if}
      {#if view.thread}<StatusBadge status={view.thread.status} />{/if}
    </div>
  </header>

  {#if view.thread?.statusDetail}
    <p class="bg-rose-50 px-6 py-2 text-sm text-rose-800" role="alert">{view.thread.statusDetail}</p>
  {/if}
  {#if view.failure}<p class="bg-amber-50 px-6 py-2 text-sm text-amber-900" role="status">{view.failure}</p>{/if}

  <div class="flex-1 space-y-3 overflow-y-auto px-6 py-4" aria-live="polite">
    {#each view.entries as entry (entry.id)}
      <div class="flex"><div class="w-full"><ItemView item={entry.item} /></div></div>
    {/each}
    {#each view.queued as turn (turn.id)}
      <div class="ml-auto max-w-[80%] rounded-2xl bg-indigo-100 px-4 py-2 whitespace-pre-wrap text-indigo-900" title="Queued">{turn.inputText}</div>
    {/each}
    {#each view.turns.filter((t) => t.status === "failed" && t.error) as turn (turn.id)}
      <p class="text-sm text-rose-700">Turn {turn.ordinal} failed: {turn.error}</p>
    {/each}
    {#each view.pending as interaction (interaction.requestId)}
      <InteractionCard {interaction} />
    {/each}
    <div bind:this={bottom}></div>
  </div>

  <Composer {threadId} running={view.running} disabled={!view.thread || view.thread.status === "failed"} />
</div>

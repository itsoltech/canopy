<script lang="ts">
  import { onMount } from "svelte";
  import type { ui } from "@canopy/contracts";
  import { memoryScopes, noteScopeLabel } from "@canopy/domain/memory-scopes";
  import { applicationName } from "#lib/application-name.ts";
  import { listMemoryNotes } from "#lib/features/memory/api.ts";
  import MemoryNoteDialog from "#lib/features/memory/MemoryNoteDialog.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import EmptyState from "#lib/shared/ui/EmptyState.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import SettingsCard from "#lib/shared/ui/SettingsCard.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";

  let scope = $state("all");
  let notes = $state.raw<ui.MemoryNote[]>([]);
  let cursor = $state("");
  let loading = $state(true);
  let failedAfter = $state<string>();
  let request: AbortController | undefined;
  let dialog: MemoryNoteDialog;

  async function load(after = "") {
    request?.abort();
    const controller = new AbortController();
    request = controller;
    loading = true;
    failedAfter = undefined;

    try {
      const result = await listMemoryNotes(scope, after, controller.signal);

      if (controller.signal.aborted) return;
      const rows = new Map((after ? notes : []).map((note) => [note.id, note]));

      for (const note of result.notes) rows.set(note.id, note);
      notes = [...rows.values()];
      cursor = result.nextCursor;
    } catch {
      if (!controller.signal.aborted) failedAfter = after;
    } finally {
      if (!controller.signal.aborted) loading = false;
    }
  }

  onMount(() => {
    void load();

    return () => request?.abort();
  });

  function changeScope(value: string) {
    scope = value;
    notes = [];
    cursor = "";
    void load();
  }

  function changeNote(id: string, updated?: ui.MemoryNote) {
    notes = updated ? notes.map((item) => (item.id === id ? updated : item)) : notes.filter((item) => item.id !== id);
    // A changed note may move between pages. Fetch a fresh cursor after the mutation.
    void load();
  }
</script>

<svelte:head><title>Memory · Settings · {applicationName}</title></svelte:head>

<section aria-label="Memory notes" class="grid min-w-0 grid-cols-1 gap-3">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0 px-1">
      <h2 class="text-base/7 font-semibold">Memory</h2>
      <p class="text-base/6 text-pretty text-muted sm:text-sm/6">Notes that agents and bots save for future turns.</p>
    </div>
    <Select aria-label="Filter notes by scope" options={memoryScopes} value={scope} onchange={changeScope} />
  </div>
  {#if notes.length}
    <SettingsCard>
      <ul role="list" class="divide-y divide-divider">
        {#each notes as note (note.id)}
          <li>
            <button
              type="button"
              class="settings-row flex w-full min-w-0 items-center gap-3 px-3 py-2 text-start focus-ring hover:bg-zinc-950/5 focus-visible:-outline-offset-2 dark:hover:bg-white/5"
              onclick={() => dialog.inspect(note)}
            >
              <span class="grid min-w-0 flex-1 grid-cols-1">
                <TruncatedText text={note.title} class="text-base/6 font-medium sm:text-sm/6" />
                <TruncatedText text={noteScopeLabel(note)} class="text-sm/5 text-muted sm:text-xs/5" />
              </span>
              {#if note.pinned}<Badge compact>Pinned</Badge>{/if}
              <Icon name="chevron-right" />
            </button>
          </li>
        {/each}
      </ul>
    </SettingsCard>
  {/if}
  {#if loading}
    <p class="flex items-center justify-center gap-2 py-6 text-base/6 text-muted sm:text-sm/6" role="status">
      <Spinner />Loading notes…
    </p>
  {:else if failedAfter !== undefined}
    <Alert tone="error" title="Could not load notes">
      Check your connection and try again.
      {#snippet actions()}<Button size="sm" onclick={() => load(failedAfter)}>Try again</Button>{/snippet}
    </Alert>
  {:else if !notes.length}
    {#if scope === "all"}
      <EmptyState title="No memory notes yet" description="Ask an agent or bot to remember a decision." />
    {:else}
      <EmptyState title="No notes in this scope">
        {#snippet action()}<Button size="sm" onclick={() => changeScope("all")}>Show all notes</Button>{/snippet}
      </EmptyState>
    {/if}
  {:else if cursor}
    <div class="justify-self-center"><Button size="sm" onclick={() => load(cursor)}>Load more notes</Button></div>
  {/if}
</section>

<MemoryNoteDialog bind:this={dialog} onchange={changeNote} onreload={() => load()} />

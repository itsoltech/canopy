<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { ui } from "@canopy/contracts";
  import { memoryScopes } from "@canopy/domain/memory-scopes";
  import { applicationName } from "#lib/application-name.ts";
  import { listMemoryNotes, type MemoryFilters } from "#lib/features/memory/api.ts";
  import MemoryFilterPicker from "#lib/features/memory/MemoryFilterPicker.svelte";
  import MemoryNoteDialog from "#lib/features/memory/MemoryNoteDialog.svelte";
  import MemoryNoteList from "#lib/features/memory/MemoryNoteList.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import HabitSettings from "#lib/features/memory/HabitSettings.svelte";
  import EmptyState from "#lib/shared/ui/EmptyState.svelte";
  import SearchField from "#lib/shared/ui/SearchField.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";

  const defaults: MemoryFilters = { scope: "all", projectId: "", workerId: "", query: "" };
  const searchId = $props.id();
  let filters = $state.raw(defaults);
  let filterOptions = $state.raw<ui.MemoryFilterOptions>();
  let notes = $state.raw<ui.MemoryNote[]>([]);
  let page = $state(0);
  let cursors = $state.raw([""]);
  let loading = $state(true);
  let failedPage = $state<number>();
  let request: AbortController | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let resultsHeading = $state<HTMLHeadingElement>();
  let dialog: MemoryNoteDialog;

  const filtered = $derived(
    filters.scope !== "all" || !!filters.projectId || !!filters.workerId || !!filters.query.trim(),
  );

  async function load(index = 0, reveal = false) {
    const after = cursors[index];

    if (after === undefined) return;
    clearTimeout(debounce);
    request?.abort();
    const controller = new AbortController();
    request = controller;
    loading = true;
    failedPage = undefined;

    try {
      const result = await listMemoryNotes({ ...filters, query: filters.query.trim() }, after, controller.signal);

      if (controller.signal.aborted) return;

      if (index > 0 && !result.notes.length) {
        await load(index - 1, reveal);

        return;
      }

      if (!after) {
        filterOptions = result.filterOptions;

        if (!filterOptions) filters = { ...defaults, scope: filters.scope };
      }

      notes = result.notes;
      page = index;
      cursors = [...cursors.slice(0, index + 1), ...(result.nextCursor ? [result.nextCursor] : [])];

      if (reveal) {
        await tick();

        if (!controller.signal.aborted) resultsHeading?.focus();
      }
    } catch {
      if (!controller.signal.aborted) failedPage = index;
    } finally {
      if (!controller.signal.aborted) loading = false;
    }
  }

  onMount(() => {
    void load();

    return () => {
      clearTimeout(debounce);
      request?.abort();
    };
  });

  function applyFilters(next: MemoryFilters, delay = 0) {
    filters = next;
    notes = [];
    page = 0;
    cursors = [""];
    loading = true;
    failedPage = undefined;
    request?.abort();
    clearTimeout(debounce);

    if (delay) debounce = setTimeout(() => void load(), delay);
    else void load();
  }

  function search(query: string) {
    const next = { ...filters, query };

    if (query.trim() === filters.query.trim()) filters = next;
    else applyFilters(next, 200);
  }

  function clearFilters() {
    document.getElementById(searchId)?.focus();
    applyFilters(defaults);
  }

  function changeNote(id: string, updated?: ui.MemoryNote) {
    notes = updated ? notes.map((note) => (note.id === id ? updated : note)) : notes.filter((note) => note.id !== id);
    // Edits can change whether a note matches and move it to another page.
    void load();
  }
</script>

<HabitSettings onapproved={() => void load()} />

<svelte:head><title>Memory · Settings · {applicationName}</title></svelte:head>

<section aria-label="Memory notes" class="grid min-w-0 grid-cols-1 gap-4">
  <div class="min-w-0 px-1">
    <h2 class="text-base/7 font-semibold">Memory</h2>
    <p class="text-base/6 text-pretty text-muted sm:text-sm/6">Notes that agents and bots save for future turns.</p>
  </div>

  <div
    class="grid min-w-0 grid-cols-2 items-center gap-2 @min-[34rem]/settings-content:grid-cols-[repeat(3,minmax(0,1fr))_auto] @min-[48rem]/settings-content:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto]"
  >
    {#if filterOptions}
      <SearchField
        id={searchId}
        label="Search notes"
        placeholder="Search notes"
        bind:value={() => filters.query, search}
        maxlength={200}
        class="col-span-full min-h-(--settings-control-height) bg-surface @min-[48rem]/settings-content:col-span-1"
      />
    {/if}
    <Select
      aria-label={`Scope — ${memoryScopes.find((item) => item.value === filters.scope)?.label ?? "All scopes"}`}
      options={memoryScopes}
      value={filters.scope}
      onchange={(scope) => applyFilters({ ...filters, scope })}
    />
    {#if filterOptions}
      <MemoryFilterPicker
        label="Project"
        allLabel="All projects"
        searchLabel="Find a project"
        options={filterOptions.projects}
        value={filters.projectId}
        onchange={(projectId) => applyFilters({ ...filters, projectId })}
      />
      <MemoryFilterPicker
        label="Worker"
        allLabel="All workers"
        searchLabel="Find a worker"
        options={filterOptions.workers}
        value={filters.workerId}
        onchange={(workerId) => applyFilters({ ...filters, workerId })}
      />
      <div class="justify-self-end">
        <Button variant="ghost" disabled={!filtered} onclick={clearFilters}>Clear filters</Button>
      </div>
    {/if}
  </div>

  {#if notes.length}
    <div class="grid min-w-0 gap-2" aria-busy={loading}>
      <h3 bind:this={resultsHeading} tabindex="-1" class="w-fit rounded-sm px-1 text-sm/5 font-medium focus-ring">
        Notes by last update
      </h3>
      <MemoryNoteList {notes} query={filters.query.trim()} onopen={(note) => dialog.inspect(note)} />
    </div>
  {/if}

  {#if loading}
    <p class="flex items-center justify-center gap-2 py-6 text-base/6 text-muted sm:text-sm/6" role="status">
      <Spinner />Loading notes…
    </p>
  {:else if failedPage !== undefined}
    <Alert tone="error" title="Could not load notes">
      Check your connection and try again.
      {#snippet actions()}<Button size="sm" onclick={() => load(failedPage)}>Try again</Button>{/snippet}
    </Alert>
  {:else if !notes.length}
    {#if filtered && filterOptions}
      <EmptyState title="No matching notes" description="Try a different search or clear the filters." />
    {:else if filtered}
      <EmptyState title="No notes in this scope">
        {#snippet action()}<Button size="sm" onclick={clearFilters}>Show all notes</Button>{/snippet}
      </EmptyState>
    {:else}
      <EmptyState title="No memory notes yet" description="Ask an agent or bot to remember something." />
    {/if}
  {/if}

  {#if notes.length && cursors.length > 1}
    <nav aria-label="Notes pagination" class="flex flex-wrap items-center justify-between gap-2 px-1">
      <span class="text-sm/5 text-muted tabular-nums sm:text-xs/5" role="status">Page {page + 1}</span>
      <div class="flex flex-wrap gap-2">
        <Button disabled={loading || page === 0} icon="chevron-left" onclick={() => load(page - 1, true)}>
          Previous
        </Button>
        <Button disabled={loading || page + 1 >= cursors.length} onclick={() => load(page + 1, true)}>Next</Button>
      </div>
    </nav>
  {/if}
</section>

<MemoryNoteDialog bind:this={dialog} onchange={changeNote} onreload={() => load()} />

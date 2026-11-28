<script lang="ts">
  import { onMount } from "svelte";
  import type { Item } from "@canopy/contracts";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import SearchField from "#lib/shared/ui/SearchField.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import { resizeHeightToContent } from "#lib/shared/ui/motion.ts";
  import { readArtifacts } from "./artifact-read.ts";
  import { artifactDetail, artifactTitle } from "./artifact-meta.ts";
  import ArtifactRow from "./ArtifactRow.svelte";
  import ArtifactViewer from "./ArtifactViewer.svelte";

  let { threadId, onshow }: { threadId: string; onshow: (item: Item) => void } = $props();

  const read = $derived(readArtifacts(threadId));
  const items = $derived(read.data?.items ?? []);
  const id = $props.id();
  let open = $state(true);
  let all = $state(false);
  let query = $state("");
  let preview = $state<{ itemId: string }>();
  const term = $derived(query.trim().toLocaleLowerCase());

  const matches = $derived(
    term
      ? items.filter((item) => `${artifactTitle(item)} ${artifactDetail(item)}`.toLocaleLowerCase().includes(term))
      : items,
  );

  const shown = $derived(all ? matches : items.slice(0, 3));

  // A retained thread can return with a warm history cursor and no replayed publications.
  onMount(() => {
    if (read.snapshot.loaded) void read.reload().catch(() => {});
  });

  function toggleAll() {
    all = !all;
    query = "";
  }
</script>

{#if items.length || read.snapshot.error}
  <section aria-label="Artifacts" class="min-w-0 px-1.5 py-1">
    <Disclosure
      bind:open
      align="center"
      grid
      summaryClass="min-h-9 gap-1 px-2 text-sm/5 text-muted hover:bg-zinc-950/4 sm:min-h-7 sm:text-xs/5 dark:hover:bg-white/5"
    >
      {#snippet summary()}
        <span class="flex items-center justify-between gap-2">
          Artifacts {#if items.length}<span class="tabular-nums">{items.length.toLocaleString()}</span>{/if}
        </span>
      {/snippet}
      <div class="t-resize-height" {@attach resizeHeightToContent}>
        <div>
          {#if all}
            <SearchField variant="inline" bind:value={query} label="Search artifacts" placeholder="Search artifacts" />
          {/if}
          <ul {id} role="list" class={["min-w-0", all && "max-h-56 overflow-y-auto overscroll-contain"]}>
            {#each shown as item (item.itemId)}
              <li class={all ? "[contain-intrinsic-block-size:auto_3rem] [content-visibility:auto]" : undefined}>
                <ArtifactRow {item} onclick={() => (preview = { itemId: item.itemId })} />
              </li>
            {/each}
          </ul>
          {#if term && !matches.length}<p role="status" class="px-2 py-1 text-sm text-muted sm:text-xs">
              No matching artifacts
            </p>{/if}
          {#if read.snapshot.error}
            <div class="flex items-center justify-between gap-1 px-2 py-1">
              <p role="status" class="text-sm text-muted sm:text-xs">
                {items.length ? "Couldn’t refresh artifacts." : "Couldn’t load artifacts."}
              </p>
              <Button variant="ghost" size="sm" onclick={() => void read.reload().catch(() => {})}>Retry</Button>
            </div>
          {/if}
          {#if items.length > 3 || all}
            <button
              type="button"
              class="min-h-9 w-full rounded-lg px-2 text-left text-sm/5 text-muted focus-ring hover:text-ink sm:min-h-8 sm:text-xs/5"
              aria-controls={id}
              aria-expanded={all}
              onclick={toggleAll}
            >
              {all ? "Show fewer" : `Show all ${items.length.toLocaleString()}`}
            </button>
          {/if}
        </div>
      </div>
    </Disclosure>
  </section>
{/if}
{#if preview}
  {#key preview}
    <ArtifactViewer
      {threadId}
      items={matches}
      selected={preview.itemId}
      onselect={(id) => {
        if (preview) preview.itemId = id;
      }}
      onclose={() => (preview = undefined)}
      onshow={(item) => {
        preview = undefined;
        onshow(item);
      }}
    />
  {/key}
{/if}

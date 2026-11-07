<script lang="ts">
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import type { ImportLibraryState } from "./import-library.svelte.ts";
  import ImportLibraryRow from "./ImportLibraryRow.svelte";
  import { counted } from "./labels.ts";

  /**
   * Settings and library of the scanned CLIs (docs/import.md, "Ustawienia i biblioteka"): items to import with what
   * they change, and, folded, the ones Canopy has already or leaves out, each with its reason.
   */
  let { library }: { library: ImportLibraryState } = $props();
</script>

{#if library.error}
  <Alert class="mx-4 my-3" tone="warning">{library.error}</Alert>
{:else if library.loading}
  <Skeleton class="m-4 h-20" />
{:else if library.items.length === 0}
  <p class="px-4 py-3 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">No settings found.</p>
{:else}
  {#if library.importable.length > 0}
    <ul role="list" class="divide-y divide-zinc-950/5 dark:divide-white/5">
      {#each library.importable as item (item.key)}
        <ImportLibraryRow {item} {library} />
      {/each}
    </ul>
  {:else}
    <p class="px-4 py-3 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Nothing new to import.</p>
  {/if}
  {#if library.others.length > 0}
    <Disclosure class="border-t border-zinc-950/5 dark:border-white/5" summaryClass="px-4 py-2.5">
      {#snippet summary()}
        <span class="text-base/6 text-zinc-700 sm:text-sm/6 dark:text-zinc-300">
          In Canopy or not imported ({counted(library.others.length, "item")})
        </span>
      {/snippet}
      <ul role="list" class="divide-y divide-zinc-950/5 dark:divide-white/5">
        {#each library.others as item (item.key)}
          <ImportLibraryRow {item} {library} />
        {/each}
      </ul>
    </Disclosure>
  {/if}
{/if}

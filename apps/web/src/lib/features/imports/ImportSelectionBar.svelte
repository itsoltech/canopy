<script lang="ts">
  import ChoiceControl from "#lib/shared/ui/ChoiceControl.svelte";
  import type { ImportState } from "./import-state.svelte.ts";
  import { size } from "./labels.ts";

  /** Select all that match, and what the selection costs in Canopy's database (docs/import.md). */
  let { imports }: { imports: ImportState } = $props();

  const total = $derived(imports.result?.total ?? 0);
  const count = $derived(imports.selectedCount);
  const share = $derived(total ? count / total : 0);
  const estimate = $derived(Number(imports.result?.estimatedBytes ?? 0n) * share);
</script>

<div
  class="flex flex-wrap items-center gap-x-3 gap-y-1 border-y border-zinc-950/5 px-4 py-2 text-base/6 sm:text-sm/6 dark:border-white/5"
>
  <label class="flex items-center gap-3">
    <span class="flex h-lh items-center">
      <ChoiceControl
        name="importAll"
        checked={total > 0 && count === total}
        indeterminate={count > 0 && count < total}
        disabled={total === 0}
        onchange={(event) => imports.selectAll(event.currentTarget.checked)}
      />
    </span>
    <span class="font-medium text-zinc-950 dark:text-white">
      {count.toLocaleString("en")} of {total.toLocaleString("en")} selected
    </span>
  </label>
  {#if count > 0}
    <span class="text-sm text-zinc-500 sm:text-xs dark:text-zinc-400">About {size(estimate)} in Canopy</span>
  {/if}
</div>

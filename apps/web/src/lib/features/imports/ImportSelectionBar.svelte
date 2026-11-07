<script lang="ts">
  import Button from "#lib/shared/ui/Button.svelte";
  import ChoiceControl from "#lib/shared/ui/ChoiceControl.svelte";
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";
  import type { ImportState } from "./import-state.svelte.ts";
  import { counted, size } from "./labels.ts";

  /** Select all that match, and what the selection costs in Canopy's database (docs/import.md). */
  let { imports, onstart }: { imports: ImportState; onstart: () => void } = $props();

  const modes = [
    { value: "continue", label: "Continue where possible" },
    { value: "history", label: "History only" },
  ];

  let mode = $state("continue");

  $effect(() => {
    imports.mode = mode === "history" ? "history" : "continue";
  });

  async function start() {
    if (await imports.start()) onstart();
  }

  const total = $derived(imports.selectable);
  const count = $derived(imports.selectedCount);
  const share = $derived(total ? count / total : 0);
  const estimate = $derived(Number(imports.result?.importableEstimatedBytes ?? 0n) * share);
  const settings = $derived(imports.library.count);

  const label = $derived(
    [count > 0 && counted(count, "thread"), settings > 0 && counted(settings, "setting")]
      .filter(Boolean)
      .join(" and ") || "0 threads",
  );
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
  <div class="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
    <SegmentedChoice label="After import" options={modes} bind:value={mode} />
    <Button
      variant="primary"
      icon="arrow-down-tray"
      disabled={count === 0 && settings === 0}
      loading={imports.starting}
      onclick={start}
    >
      Import {label}
    </Button>
  </div>
</div>

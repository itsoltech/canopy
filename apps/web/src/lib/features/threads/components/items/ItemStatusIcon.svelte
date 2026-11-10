<script lang="ts">
  import { ItemStatus } from "@canopy/contracts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { iconSwap } from "#lib/shared/ui/motion.ts";
  import Spinner from "#lib/shared/ui/Spinner.svelte";

  /** In progress, failed, declined or interrupted; completed shows nothing (the default state). A new one swaps in. */
  let { status, count }: { status: ItemStatus; count?: number } = $props();
</script>

{#snippet label(text: string)}
  {#if count === undefined}{text}{:else}{count}<span class="sr-only sm:not-sr-only"> {text.toLowerCase()}</span>{/if}
{/snippet}

{#if status === ItemStatus.IN_PROGRESS}
  <span
    class="flex items-center gap-1.5 text-sky-700 dark:text-sky-400"
    title={count === undefined ? undefined : `${count} running`}
    ><span class="flex" in:iconSwap><Spinner class="size-3.5" /></span>{#if count !== undefined}{count}{/if}<span
      class="sr-only sm:not-sr-only">{count === undefined ? "Running" : "running"}</span
    ></span
  >
{:else if status === ItemStatus.FAILED}
  <span
    class="flex items-center gap-1 text-rose-700 dark:text-rose-400"
    title={count === undefined ? undefined : `${count} failed`}
    ><span class="flex" in:iconSwap><Icon name="x-circle" tone="inherit" class="size-3.5" /></span>{@render label(
      "Failed",
    )}</span
  >
{:else if status === ItemStatus.DECLINED}
  <span
    class="flex items-center gap-1 text-rose-700 dark:text-rose-400"
    title={count === undefined ? undefined : `${count} declined`}
    ><span class="flex" in:iconSwap><Icon name="hand-raised" tone="inherit" class="size-3.5" /></span>{@render label(
      "Declined",
    )}</span
  >
{:else if status === ItemStatus.INTERRUPTED}
  <span
    class="flex items-center gap-1 text-orange-700 dark:text-orange-400"
    title={count === undefined ? undefined : `${count} interrupted`}
    ><span class="flex" in:iconSwap><Icon name="stop" tone="inherit" class="size-3.5" /></span>{@render label(
      "Interrupted",
    )}</span
  >
{/if}

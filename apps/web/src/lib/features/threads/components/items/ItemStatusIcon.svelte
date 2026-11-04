<script lang="ts">
  import { ItemStatus } from "@canopy/contracts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { iconSwap } from "#lib/shared/ui/motion.ts";
  import Spinner from "#lib/shared/ui/Spinner.svelte";

  /** In progress, failed, declined or interrupted; completed shows nothing (the default state). A new one swaps in. */
  let { status }: { status: ItemStatus } = $props();
</script>

{#if status === ItemStatus.IN_PROGRESS}
  <span class="flex items-center gap-1.5 text-sky-700 dark:text-sky-400"
    ><span class="flex" in:iconSwap><Spinner class="size-3.5" /></span><span class="sr-only sm:not-sr-only"
      >Running</span
    ></span
  >
{:else if status === ItemStatus.FAILED}
  <span class="flex items-center gap-1 text-rose-700 dark:text-rose-400"
    ><span class="flex" in:iconSwap><Icon name="x-circle" tone="inherit" class="size-3.5" /></span>Failed</span
  >
{:else if status === ItemStatus.DECLINED}
  <span class="flex items-center gap-1 text-rose-700 dark:text-rose-400"
    ><span class="flex" in:iconSwap><Icon name="hand-raised" tone="inherit" class="size-3.5" /></span>Declined</span
  >
{:else if status === ItemStatus.INTERRUPTED}
  <span class="flex items-center gap-1 text-orange-700 dark:text-orange-400"
    ><span class="flex" in:iconSwap><Icon name="stop" tone="inherit" class="size-3.5" /></span>Interrupted</span
  >
{/if}

<script lang="ts">
  import { ItemStatus } from "@open-agents/contracts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";

  /** In progress, failed, declined or interrupted; completed shows nothing (the default state). */
  let { status }: { status: ItemStatus } = $props();
</script>

{#if status === ItemStatus.IN_PROGRESS}
  <span class="flex items-center gap-1.5 text-sky-700 dark:text-sky-400"><Spinner class="size-3.5" /><span class="sr-only sm:not-sr-only">Running</span></span>
{:else if status === ItemStatus.FAILED}
  <span class="flex items-center gap-1 text-rose-700 dark:text-rose-400"><Icon name="x-circle" class="size-3.5" />Failed</span>
{:else if status === ItemStatus.DECLINED}
  <span class="flex items-center gap-1 text-rose-700 dark:text-rose-400"><Icon name="hand-raised" class="size-3.5" />Declined</span>
{:else if status === ItemStatus.INTERRUPTED}
  <span class="flex items-center gap-1 text-orange-700 dark:text-orange-400"><Icon name="stop" class="size-3.5" />Interrupted</span>
{/if}

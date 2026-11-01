<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { formatAge, formatDateTime, isoDateTime } from "#lib/shared/format.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";

  /**
   * Thread status as T3 shows it in lists: what needs attention in colour (needs input, working,
   * failed), otherwise just the age.
   */
  let { thread, class: className }: { thread: ui.Thread; class?: ClassValue } = $props();
  const waiting = $derived(thread.status === "waiting_input" || thread.pendingInteractions > 0);
</script>

<span class={["flex shrink-0 items-center gap-1 text-sm/5 whitespace-nowrap tabular-nums sm:text-xs/5", className]}>
  {#if waiting}
    <span class="flex items-center gap-1 text-amber-700 dark:text-amber-400"><Icon name="hand-raised" class="size-3.5" />Needs input</span>
  {:else if thread.status === "running" || thread.status === "creating"}
    <span class="flex items-center gap-1 text-sky-700 dark:text-sky-400"><Spinner class="size-3.5" />{thread.status === "creating" ? "Starting" : "Working"}</span>
  {:else if thread.status === "failed"}
    <span class="flex items-center gap-1 text-rose-700 dark:text-rose-400"><Icon name="x-circle" class="size-3.5" />Failed</span>
  {:else if thread.status === "interrupted"}
    <span class="flex items-center gap-1 text-orange-700 dark:text-orange-400"><Icon name="stop" class="size-3.5" />Interrupted</span>
  {:else}
    <time class="text-zinc-500" datetime={isoDateTime(thread.createdAt)} title={formatDateTime(thread.createdAt)}>{formatAge(thread.createdAt)}</time>
  {/if}
</span>

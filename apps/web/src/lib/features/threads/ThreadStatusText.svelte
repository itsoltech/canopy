<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { formatAge, formatDateTime, isoDateTime } from "#lib/shared/format.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { swap } from "#lib/shared/ui/motion.ts";
  import { activityOf, asksAgent, needsYou } from "./activity.ts";

  /**
   * Thread status as T3 shows it in lists: what needs attention in colour (needs you, asking its
   * agent, working for how long, failed), otherwise how long ago it was last active. A new state swaps in.
   */
  let { thread, class: className }: { thread: ui.Thread; class?: ClassValue } = $props();
  const at = $derived(activityOf(thread));
  const age = $derived(formatAge(at, clock.now));
  const state = $derived(needsYou(thread) ? "needs" : asksAgent(thread) ? "asks" : thread.status);
</script>

<span class={["flex shrink-0 items-center gap-1 text-sm/5 whitespace-nowrap tabular-nums sm:text-xs/5", className]}>
  {#key state}<span class="flex items-center" in:swap>
  {#if needsYou(thread)}
    <span class="flex items-center gap-1 text-amber-700 dark:text-amber-400"><Icon name="hand-raised" class="size-3.5" />Needs input</span>
  {:else if asksAgent(thread)}
    <span class="flex items-center gap-1 text-violet-700 dark:text-violet-400" title="Waiting for the main agent to answer. You can answer instead.">
      <Icon name="hand-raised" class="size-3.5" />Asking agent
    </span>
  {:else if thread.status === "creating"}
    <span class="flex items-center gap-1 text-sky-700 dark:text-sky-400"><Spinner class="size-3.5" />Starting</span>
  {:else if thread.status === "running"}
    <span class="flex items-center gap-1 text-sky-700 dark:text-sky-400" title="Working since {formatDateTime(at)}">
      <Spinner class="size-3.5" />Working{age && age !== "now" ? ` ${age}` : ""}
    </span>
  {:else if thread.status === "failed"}
    <span class="flex items-center gap-1 text-rose-700 dark:text-rose-400"><Icon name="x-circle" class="size-3.5" />Failed</span>
  {:else if thread.status === "interrupted"}
    <span class="flex items-center gap-1 text-orange-700 dark:text-orange-400"><Icon name="stop" class="size-3.5" />Interrupted</span>
  {:else}
    <time class="text-zinc-500" datetime={isoDateTime(at)} title="Last active {formatDateTime(at)}">{age}</time>
  {/if}
  </span>{/key}
</span>

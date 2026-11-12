<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { formatAge, formatDateTime, isoDateTime } from "#lib/shared/format.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { swap } from "#lib/shared/ui/motion.ts";
  import { activityOf, asksAgent, needsYou } from "./activity.ts";
  import { workingLabel } from "@canopy/domain/thread-activity";
  import { workingColors } from "@canopy/ui/thread-row";
  import { lingeringResult } from "./result.svelte.ts";

  /**
   * Thread status in lists: what needs attention in colour (needs you, asking its
   * agent, working for how long, a finished turn you have not seen: completed, failed, interrupted),
   * otherwise how long ago it was last active. A new state swaps in.
   * `icons={false}` drops the marks of waiting and working where a ThreadActivityMark leads the row.
   */
  let { thread, icons = true, class: className }: { thread: ui.Thread; icons?: boolean; class?: ClassValue } = $props();
  const at = $derived(activityOf(thread));
  const age = $derived(formatAge(at, clock.now));

  // A finished turn you have not seen yet (kept a moment after you saw it) wins over the quiet states.
  const result = lingeringResult(() => thread);

  const state = $derived(
    needsYou(thread)
      ? "needs"
      : asksAgent(thread)
        ? "asks"
        : thread.turnStarting
          ? "creating"
          : thread.status === "running" || thread.status === "creating"
            ? thread.status
            : (result.current ?? thread.status),
  );
</script>

<span
  class={["flex shrink-0 items-center gap-1 text-sm/5 whitespace-nowrap tabular-nums sm:text-xs/5", className]}
  style:--working-light={workingColors.light.text}
  style:--working-dark={workingColors.dark.text}
>
  {#key state}<span class="flex items-center" in:swap>
      {#if needsYou(thread)}
        <span class="flex items-center gap-1 text-amber-700 dark:text-amber-400"
          >{#if icons}<Icon name="hand-raised" tone="inherit" class="size-3.5" />{/if}Needs input</span
        >
      {:else if asksAgent(thread)}
        <span
          class="flex items-center gap-1 text-violet-700 dark:text-violet-400"
          title="Waiting for the main agent to answer. You can answer instead."
        >
          {#if icons}<Icon name="hand-raised" tone="inherit" class="size-3.5" />{/if}Asking agent
        </span>
      {:else if thread.status === "creating" || thread.turnStarting}
        <span class="flex items-center gap-1 text-(--working-light) dark:text-(--working-dark)"
          >{#if icons}<Spinner class="size-3.5" />{/if}Starting</span
        >
      {:else if thread.status === "running"}
        <span
          class="flex items-center gap-1 text-(--working-light) dark:text-(--working-dark)"
          title="Working since {formatDateTime(at)}"
        >
          {#if icons}<Spinner class="size-3.5" />{/if}{workingLabel(thread, clock.now)}
        </span>
      {:else if state === "completed"}
        <span
          class="flex items-center gap-1 text-emerald-700 dark:text-emerald-400"
          title="Finished {formatDateTime(at)}, not opened since"
          ><Icon name="check-circle" tone="inherit" class="size-3.5" />Completed</span
        >
      {:else if state === "failed"}
        <span class="flex items-center gap-1 text-rose-700 dark:text-rose-400"
          ><Icon name="x-circle" tone="inherit" class="size-3.5" />Failed</span
        >
      {:else if state === "interrupted"}
        <span class="flex items-center gap-1 text-orange-700 dark:text-orange-400"
          ><Icon name="stop" tone="inherit" class="size-3.5" />Interrupted</span
        >
      {:else}
        <time class="text-zinc-500" datetime={isoDateTime(at)} title="Last active {formatDateTime(at)}">{age}</time>
      {/if}
    </span>{/key}
</span>

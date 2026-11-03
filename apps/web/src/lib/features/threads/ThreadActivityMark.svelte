<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { iconSwap, pop } from "#lib/shared/ui/motion.ts";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { workState } from "./activity.ts";

  /**
   * The leading mark of a thread in lists: a spinner while a turn runs or the thread starts, a breathing
   * bolt while only background tasks run, an amber hand when it needs you, a violet one while it asks its
   * agent, otherwise `idle` (the project's avatar, the side thread's mark). The box keeps its size in every
   * state; running background tasks add their number at its corner. A new state swaps in (icon swap 09).
   */
  let { thread, size = "md", class: className, idle }: { thread: ui.Thread; size?: "md" | "sm"; class?: ClassValue; idle: Snippet } = $props();

  const state = $derived(workState(thread));
  const tasks = $derived(thread.backgroundTasks);
  const tasksLabel = $derived(`${tasks} running in background`);
  const label = $derived(
    state === "needs" ? "Needs input"
    : state === "asks" ? "Asking its agent"
    : state === "starting" ? "Starting"
    : state === "running" ? (tasks > 0 ? `Working · ${tasksLabel}` : "Working")
    : state === "background" ? tasksLabel
    : undefined,
  );
  const glyph = $derived(size === "md" ? "size-4" : "size-3.5");
</script>

<span class={["relative inline-grid shrink-0 place-items-center", size === "md" ? "size-4.5" : "size-3.5", className]} {@attach label ? tooltip(label) : undefined}>
  {#key state}
    <span class="col-start-1 row-start-1 grid place-items-center" in:iconSwap>
      {#if state === "needs" || state === "asks"}
        <Icon name="hand-raised" class={[glyph, state === "needs" ? "fill-amber-600 dark:fill-amber-400" : "fill-violet-600 dark:fill-violet-400"]} />
      {:else if state === "starting" || state === "running"}
        <Spinner class={[glyph, "text-sky-600 dark:text-sky-400"]} />
      {:else if state === "background"}
        <Icon name="bolt" class={[glyph, "t-pulse fill-sky-600 dark:fill-sky-400"]} />
      {:else}
        {@render idle()}
      {/if}
    </span>
  {/key}
  {#if tasks > 0}
    {#key tasks}
      <span
        class="absolute -right-1 -bottom-1 grid h-3 min-w-3 place-items-center rounded-full bg-sky-600 px-0.5 text-[0.5625rem]/none font-semibold text-white tabular-nums ring-2 ring-zinc-50 dark:bg-sky-500 dark:ring-zinc-950"
        aria-hidden="true"
        in:pop
      >{tasks}</span>
    {/key}
    <span class="sr-only">{tasksLabel}</span>
  {/if}
</span>

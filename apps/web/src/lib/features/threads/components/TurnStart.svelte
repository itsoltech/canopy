<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import { goalLook } from "#lib/features/goals/goals.ts";
  import { formatDateTime, formatDay, formatTime, isoDateTime } from "#lib/shared/format.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { useThreadDirectory } from "../thread-directory.ts";
  import { silentTriggerLabel } from "../turn-origin.ts";
  import { turnReveal } from "../turn-reveal.svelte.ts";

  /**
   * Boundary before a turn: space, and a pill with the day where a new day starts (`newDay`). What
   * matters stays visible: a mark when it worked on a goal (with the objective, when it is the goal the
   * page knows) and, for turns without an input (provider wake-up, recovery), what started it. The turn's
   * number and when it started (or was queued) wait at the right, over its input, until the turn is
   * hovered or focused (turn-reveal); they are only faded, so screen readers still read them.
   */
  let { turn, newDay }: { turn: ui.Turn; newDay: boolean } = $props();
  const directory = useThreadDirectory();
  const label = $derived(silentTriggerLabel(turn));
  const at = $derived(turn.startedAt ?? turn.queuedAt);
  const goal = $derived(turn.goalId ? directory.goal(turn.goalId) : undefined);
  turnReveal.listen();
</script>

<div data-shown={turnReveal.shows(turn.id) || undefined}>
  {#if newDay && at}
    <p class="flex justify-center pb-2">
      <time datetime={isoDateTime(at)} class="rounded-full bg-zinc-950/5 px-2.5 py-0.5 text-sm/5 font-medium text-zinc-600 sm:text-xs/5 dark:bg-white/8 dark:text-zinc-400">{formatDay(at)}</time>
    </p>
  {/if}
  <div class="flex h-5 items-center gap-3 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
    {#if turn.goalId}
      <span class="flex min-w-0 items-center gap-1 text-sky-700 dark:text-sky-400" {@attach tooltip(goal ? `Goal (${goalLook(goal.status).label.toLowerCase()}): ${goal.objective}` : undefined)}>
        <Icon name="flag" class="size-3.5" />Goal{#if goal}<span class="sr-only">: {goal.objective.slice(0, 200)}</span>{/if}
      </span>
    {/if}
    {#if label}<span class="truncate">{label}</span>{/if}
    <span class="ml-auto shrink-0 t-quiet tabular-nums">
      Turn {turn.ordinal}{#if at}<span aria-hidden="true">{" · "}<time datetime={isoDateTime(at)} title={formatDateTime(at)}>{formatTime(at)}</time></span><span class="sr-only">, {formatDateTime(at)}</span>{/if}
    </span>
  </div>
</div>

<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import { goalLook } from "#lib/features/goals/goals.ts";
  import { formatDateTime, isoDateTime } from "#lib/shared/format.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { useThreadDirectory } from "../thread-directory.ts";
  import { silentTriggerLabel } from "../turn-origin.ts";

  /**
   * Boundary before a turn: number, when it started (or was queued), a mark when it worked on a goal
   * (with the objective, when it is the goal the page knows) and, for turns without an input (provider
   * wake-up, recovery), what started it. Inputs show their own origin below.
   */
  let { turn }: { turn: ui.Turn } = $props();
  const directory = useThreadDirectory();
  const label = $derived(silentTriggerLabel(turn));
  const at = $derived(turn.startedAt ?? turn.queuedAt);
  const goal = $derived(turn.goalId ? directory.goal(turn.goalId) : undefined);
</script>

<div class="flex items-center gap-3 pt-4 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
  <span class="font-medium text-zinc-700 tabular-nums dark:text-zinc-300">Turn {turn.ordinal}</span>
  {#if turn.goalId}
    <span class="flex min-w-0 items-center gap-1 text-sky-700 dark:text-sky-400" {@attach tooltip(goal ? `Goal (${goalLook(goal.status).label.toLowerCase()}): ${goal.objective}` : undefined)}>
      <Icon name="flag" class="size-3.5" />Goal{#if goal}<span class="sr-only">: {goal.objective.slice(0, 200)}</span>{/if}
    </span>
  {/if}
  {#if label}<span>{label}</span>{/if}
  {#if at}<time datetime={isoDateTime(at)} class="max-sm:hidden">{formatDateTime(at)}</time>{/if}
  <span class="h-px flex-1 bg-zinc-950/5 dark:bg-white/10"></span>
</div>

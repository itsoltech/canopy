<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { goalLook } from "#lib/features/goals/goals.ts";
  import { formatDateTime, formatDay, formatTime, isoDateTime } from "#lib/shared/format.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { useThreadDirectory } from "../thread-directory.ts";
  import { silentTriggerLabel } from "@canopy/domain/turn-origin";
  import { turnReveal } from "../turn-reveal.svelte.ts";
  import RewindButton from "./RewindButton.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";

  /**
   * Boundary before a turn: space, and a pill with the day where a new day starts (`newDay`). What
   * matters stays visible: a mark when it worked on a goal (with the objective, when it is the goal the
   * page knows) and, for turns without an input (provider wake-up, recovery), what started it. When it
   * started (or was queued) waits at the right, over its input, until the turn is hovered or focused
   * (turn-reveal); the turn's number is there for screen readers only. `number` counts
   * the shown turns (turns taken out of the queue are not; default: the ordinal).
   */
  let { turn, newDay, number = turn.ordinal }: { turn: ui.Turn; newDay: boolean; number?: number } = $props();
  const directory = useThreadDirectory();
  const label = $derived(silentTriggerLabel(turn));
  const at = $derived(turn.startedAt ?? turn.queuedAt);
  const goal = $derived(turn.goalId ? directory.goal(turn.goalId) : undefined);

  const ownMessage = $derived(
    !turn.inherited &&
      turn.trigger === "user" &&
      !turn.withdrawn &&
      turn.shellCommand === undefined &&
      Boolean(turn.startedAt),
  );

  turnReveal.listen();
</script>

<div data-shown={turnReveal.shows(turn.id) || undefined}>
  {#if newDay && at}
    <p class="flex justify-center pb-2">
      <time
        datetime={isoDateTime(at)}
        class="rounded-full bg-zinc-950/5 px-2.5 py-0.5 text-sm/5 font-medium text-zinc-600 sm:text-xs/5 dark:bg-white/8 dark:text-zinc-400"
        >{formatDay(at)}</time
      >
    </p>
  {/if}
  <div class="flex min-h-7 items-center gap-3 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
    {#if turn.goalId}
      <span
        class="flex min-w-0 items-center gap-1 text-sky-700 dark:text-sky-400"
        {@attach tooltip(goal ? `Goal (${goalLook(goal.status).label.toLowerCase()}): ${goal.objective}` : undefined)}
      >
        <Icon name="flag" tone="inherit" class="size-3.5" />Goal{#if goal}<span class="sr-only"
            >: {goal.objective.slice(0, 200)}</span
          >{/if}
      </span>
    {/if}
    {#if label}<span class="truncate">{label}</span>{/if}
    <div class="t-quiet t-quiet-touch ml-auto flex shrink-0 items-center">
      {#if ownMessage}
        {#if directory.canRewind && !turn.rewindId}<RewindButton threadId={directory.currentId} turnId={turn.id} />{/if}
        <CopyButton text={turn.messageText || turn.inputText} label="Copy message" />
      {/if}
      <span class="shrink-0 pl-1.5 tabular-nums">
        <span class="sr-only"
          >Turn {number}{#if at}, {formatDateTime(at)}{/if}</span
        >{#if at}<time aria-hidden="true" datetime={isoDateTime(at)} title={formatDateTime(at)}>{formatTime(at)}</time
          >{/if}
      </span>
    </div>
  </div>
</div>

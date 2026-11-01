<script lang="ts">
  import type { Provider, ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { formatCount } from "#lib/shared/format.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import { textTones } from "#lib/shared/ui/tone.ts";
  import { setGoal } from "./api.ts";
  import GoalStats from "./GoalStats.svelte";
  import { formatElapsed, goalActions, goalLook, goalPending, isFinishedGoal, type GoalAction } from "./goals.ts";

  /**
   * The thread's goal above the composer: objective, status and usage in one line that unfolds into the
   * details (whole objective, the harness's last verdict, tokens, time, turns or checks). Pause, resume
   * and clear (asks once more); an achieved goal can be dismissed. The harness confirms a decision
   * with its next report, until then the status says what it waits for. `onchange` gets the goal the
   * gateway returned, before the stream brings it.
   */
  let {
    goal,
    provider,
    threadId,
    disabled = false,
    onchange,
    ondismiss,
    class: className,
  }: {
    goal: ui.Goal;
    provider: Provider;
    threadId: string;
    disabled?: boolean;
    onchange?: ((goal: ui.Goal) => void) | undefined;
    ondismiss?: (() => void) | undefined;
    class?: ClassValue;
  } = $props();

  const id = $props.id();
  const look = $derived(goalLook(goal.status));
  const pending = $derived(goalPending(goal));
  const actions = $derived(goalActions(goal.status));
  const finished = $derived(isFinishedGoal(goal.status));
  const usage = $derived(
    [goal.tokensUsed > 0n || goal.tokenBudget > 0n ? `${formatCount(goal.tokensUsed)}${goal.tokenBudget > 0n ? ` / ${formatCount(goal.tokenBudget)}` : ""} tokens` : "", goal.timeUsedSeconds > 0n ? formatElapsed(goal.timeUsedSeconds) : ""]
      .filter(Boolean)
      .join(" · "),
  );
  // The harness's verdict matters once it stopped working on the goal (achieved, blocked, a limit).
  const reason = $derived(goal.status !== "active" && goal.status !== "paused" ? goal.lastReason : "");

  let open = $state(false);
  let confirming = $state(false);
  let busy = $state<GoalAction>();
  let error = $state<string>();

  async function act(action: Exclude<GoalAction, "set">) {
    busy = action;
    error = undefined;
    try {
      const updated = await setGoal(threadId, action);
      if (updated) onchange?.(updated);
      confirming = false;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The change failed";
    } finally {
      busy = undefined;
    }
  }
</script>

<section aria-labelledby="{id}-label" class={["rounded-xl bg-zinc-950/2.5 ring-1 ring-zinc-950/5 dark:bg-white/4 dark:ring-white/10", className]}>
  <div class="flex items-center gap-1 py-1 pr-1 pl-1.5">
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1.5 text-left focus-ring hover:bg-zinc-950/2.5 dark:hover:bg-white/4"
      aria-expanded={open}
      aria-controls="{id}-details"
      onclick={() => (open = !open)}
    >
      <Icon name={look.icon} class={["shrink-0", textTones[look.tone]]} />
      <span id="{id}-label" class="sr-only">Goal</span>
      <span class="min-w-0 flex-1 truncate text-base/6 text-zinc-800 sm:text-sm/6 dark:text-zinc-200">{goal.objective}</span>
      <span class={["flex shrink-0 items-center gap-1.5 text-sm/5 whitespace-nowrap sm:text-xs/5", textTones[look.tone]]}>
        <StatusDot tone={look.tone} active={look.active && !pending} />{pending ?? look.label}
      </span>
      {#if usage}<span class="shrink-0 text-sm/5 text-zinc-500 tabular-nums max-sm:hidden sm:text-xs/5 dark:text-zinc-400">{usage}</span>{/if}
      <Icon name="chevron-down" class={["size-3.5 shrink-0 fill-zinc-400 motion-safe:transition-transform dark:fill-zinc-500", open && "rotate-180"]} />
    </button>
    <div class="flex shrink-0 items-center gap-0.5">
      {#if confirming}
        <Button size="sm" variant="danger" loading={busy === "clear"} onclick={() => act("clear")}>Clear goal</Button>
        <Button size="sm" variant="ghost" disabled={Boolean(busy)} onclick={() => (confirming = false)}>Keep</Button>
      {:else}
        {#if actions.pause}
          <IconButton icon="pause" size="sm" label="Pause the goal" disabled={disabled || Boolean(busy)} aria-busy={busy === "pause" || undefined} onclick={() => act("pause")} />
        {:else if actions.resume}
          <IconButton icon="play" size="sm" label="Resume the goal" disabled={disabled || Boolean(busy)} aria-busy={busy === "resume" || undefined} onclick={() => act("resume")} />
        {/if}
        {#if actions.clear}
          <IconButton icon="x-mark" size="sm" label="Clear the goal…" disabled={disabled || Boolean(busy)} onclick={() => (confirming = true)} />
        {:else if finished && ondismiss}
          <IconButton icon="x-mark" size="sm" label="Dismiss" onclick={ondismiss} />
        {/if}
      {/if}
    </div>
  </div>
  {#if reason && !open}
    <p class="line-clamp-2 px-3 pb-2 text-sm/5 text-pretty text-zinc-600 sm:text-xs/5 dark:text-zinc-400">{reason}</p>
  {/if}
  {#if error}<p class="px-3 pb-2 text-sm/5 text-rose-700 sm:text-xs/5 dark:text-rose-400" role="alert">{error}</p>{/if}
  <div id="{id}-details" hidden={!open} class="grid max-h-[40dvh] gap-3 overflow-y-auto border-t border-zinc-950/5 px-3 pt-2.5 pb-3 dark:border-white/10">
    {#if open}
      <p class="text-base/6 break-words whitespace-pre-wrap text-zinc-950 sm:text-sm/6 dark:text-white">{goal.objective}</p>
      {#if goal.lastReason}
        <p class="text-sm/5 text-pretty text-zinc-600 dark:text-zinc-400"><span class="font-medium text-zinc-700 dark:text-zinc-300">Latest check:</span> {goal.lastReason}</p>
      {/if}
      <GoalStats {goal} {provider} />
    {/if}
  </div>
</section>

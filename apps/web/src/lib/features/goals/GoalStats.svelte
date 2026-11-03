<script lang="ts">
  import type { Provider, ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { formatCount, formatDateTime } from "#lib/shared/format.ts";
  import GoalStat from "./GoalStat.svelte";
  import { budgetShare, formatElapsed, iterationsLabel } from "./goals.ts";

  /**
   * What a goal used so far, as the harness reports it: tokens (against the budget, with a meter), time,
   * turns (Codex) or checks (Claude), who set it and when.
   */
  let { goal, provider, class: className }: { goal: ui.Goal; provider: Provider; class?: ClassValue } = $props();
  const share = $derived(budgetShare(goal));
</script>

<dl class={["grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4", className]}>
  <GoalStat label="Tokens">
    {#snippet value()}
      {formatCount(goal.tokensUsed)}{#if goal.tokenBudget > 0n}<span class="font-normal text-zinc-500 dark:text-zinc-400">{" / "}{formatCount(goal.tokenBudget)}</span>{/if}
    {/snippet}
    {#if share !== undefined}
      <div class="h-1 overflow-hidden rounded-full bg-zinc-950/5 dark:bg-white/10" role="meter" aria-label="Token budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
        <div class={["h-full w-(--share) rounded-full", share >= 1 ? "bg-amber-500" : "bg-sky-500"]} style:--share="{Math.round(share * 100)}%"></div>
      </div>
    {/if}
  </GoalStat>
  <GoalStat label="Time">
    {#snippet value()}{formatElapsed(goal.timeUsedSeconds)}{/snippet}
  </GoalStat>
  <GoalStat label="Progress">
    {#snippet value()}{iterationsLabel(goal.iterations, provider)}{/snippet}
  </GoalStat>
  <GoalStat label="Set by">
    {#snippet value()}<span class="font-normal" title={formatDateTime(goal.createdAt)}>{goal.createdBy === "provider" ? "The agent" : "You"}</span>{/snippet}
  </GoalStat>
</dl>

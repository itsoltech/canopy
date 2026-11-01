<script lang="ts">
  import type { Provider, ui } from "@open-agents/contracts";
  import { formatCount, formatDateTime } from "#lib/shared/format.ts";
  import { budgetShare, formatElapsed, iterationsLabel } from "./goals.ts";

  /**
   * What a goal used so far, as the harness reports it: tokens (against the budget, with a meter), time,
   * turns (Codex) or checks (Claude), who set it and when.
   */
  let { goal, provider }: { goal: ui.Goal; provider: Provider } = $props();
  const share = $derived(budgetShare(goal));
</script>

<dl class="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
  <div class="grid gap-0.5">
    <dt class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Tokens</dt>
    <dd class="text-base/6 font-medium text-zinc-950 tabular-nums sm:text-sm/5 dark:text-white">
      {formatCount(goal.tokensUsed)}{#if goal.tokenBudget > 0n}<span class="font-normal text-zinc-500 dark:text-zinc-400"> / {formatCount(goal.tokenBudget)}</span>{/if}
    </dd>
    {#if share !== undefined}
      <meter class="sr-only" min="0" max="1" value={share} aria-label="Token budget used"></meter>
      <div class="h-1 overflow-hidden rounded-full bg-zinc-950/5 dark:bg-white/10" aria-hidden="true">
        <div class={["h-full w-(--share) rounded-full", share >= 1 ? "bg-amber-500" : "bg-sky-500"]} style:--share="{Math.round(share * 100)}%"></div>
      </div>
    {/if}
  </div>
  <div class="grid content-start gap-0.5">
    <dt class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Time</dt>
    <dd class="text-base/6 font-medium text-zinc-950 tabular-nums sm:text-sm/5 dark:text-white">{formatElapsed(goal.timeUsedSeconds)}</dd>
  </div>
  <div class="grid content-start gap-0.5">
    <dt class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Progress</dt>
    <dd class="text-base/6 font-medium text-zinc-950 tabular-nums sm:text-sm/5 dark:text-white">{iterationsLabel(goal.iterations, provider)}</dd>
  </div>
  <div class="grid content-start gap-0.5">
    <dt class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Set by</dt>
    <dd class="text-base/6 text-zinc-950 sm:text-sm/5 dark:text-white" title={formatDateTime(goal.createdAt)}>{goal.createdBy === "provider" ? "The agent" : "You"}</dd>
  </div>
</dl>

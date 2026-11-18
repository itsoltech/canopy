<script lang="ts">
  import {
    count,
    effectiveCost,
    estimatedCost,
    reportedCost,
    shortCount,
    totalTokens,
    type UsageAmounts,
    type UsageView,
  } from "./format.ts";
  import UsageCostCoverage from "./UsageCostCoverage.svelte";

  let { totals, view }: { totals: UsageAmounts; view: UsageView } = $props();

  const counters = $derived([
    { label: "Input", value: totals.input },
    { label: "Output", value: totals.output },
    { label: "Cache read", value: totals.cacheRead },
    { label: "Cache write", value: totals.cacheWrite },
    { label: "Reasoning", value: totals.reasoning },
  ]);
</script>

<section aria-label="Usage totals" class="grid gap-4">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">{view === "cost" ? "Cost" : "Total tokens"}</p>
      <p
        class="mt-1 text-3xl/10 font-semibold tracking-tight tabular-nums select-text"
        title={view === "tokens" ? count(totalTokens(totals)) : undefined}
      >
        {view === "cost" ? effectiveCost(totals) : shortCount(totalTokens(totals))}
      </p>
    </div>
    {#if view === "cost"}
      <div class="text-right">
        <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">
          {count(totals.reports)}
          {totals.reports === 1n ? "report" : "reports"}
        </p>
        <UsageCostCoverage amounts={totals} />
      </div>
    {:else}
      <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">Input + output</p>
    {/if}
  </div>
  {#if view === "cost"}
    <p class="text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">
      Each report uses complete reported cost or its estimated API cost. Estimates value consumption at OpenAI API
      rates, separate from subscription charges.
    </p>
    <dl class="grid grid-cols-2 gap-3">
      {#each [{ label: "Reported cost", value: reportedCost(totals), reports: totals.costReports }, { label: "Estimated API cost", value: estimatedCost(totals), reports: totals.estimatedCostReports }] as cost (cost.label)}
        <div class="min-w-0 rounded-xl border border-divider p-3">
          <dt class="text-sm/5 text-zinc-500 dark:text-zinc-400">{cost.label}</dt>
          <dd class="mt-1 text-xl/7 font-medium wrap-anywhere tabular-nums select-text">{cost.value}</dd>
          <dd class="mt-1 text-xs/5 text-zinc-500 tabular-nums dark:text-zinc-400">
            Complete for {count(cost.reports)} of {count(totals.reports)}
            {totals.reports === 1n ? "report" : "reports"}
          </dd>
        </div>
      {/each}
    </dl>
    <p class="text-xs/5 text-zinc-500 dark:text-zinc-400">
      The amounts above can cover the same usage. The total counts each report once.
    </p>
  {/if}
  <dl class="grid grid-cols-2 gap-3 sm:grid-cols-5">
    {#each counters as counter (counter.label)}
      <div class="min-w-0 rounded-xl border border-divider p-3">
        <dt class="text-sm/5 text-zinc-500 dark:text-zinc-400">{counter.label}</dt>
        <dd class="mt-1 text-base/6 font-medium wrap-anywhere tabular-nums select-text">
          {count(counter.value)}
        </dd>
      </div>
    {/each}
  </dl>
  <p class="text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">
    Cache read and write are included in input. Reasoning is included in output. Token details depend on provider
    reports.
  </p>
</section>

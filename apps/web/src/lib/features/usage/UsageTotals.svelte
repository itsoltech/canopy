<script lang="ts">
  import AnimatedNumber from "#lib/shared/ui/AnimatedNumber.svelte";
  import {
    count,
    effectiveCost,
    hasPartialCost,
    shortCount,
    totalTokens,
    type UsageAmounts,
    type UsageView,
  } from "./format.ts";

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
        {#key view}
          <AnimatedNumber
            value={view === "cost" ? effectiveCost(totals) : shortCount(totalTokens(totals))}
            amount={view === "cost" ? totals.effectiveCost : totalTokens(totals)}
          />
        {/key}
      </p>
    </div>
    {#if view === "cost"}
      {#if hasPartialCost(totals)}
        <p class="text-sm/5 text-zinc-500 tabular-nums dark:text-zinc-400">
          <AnimatedNumber
            value={count(totals.unknownEffectiveCostReports)}
            amount={totals.unknownEffectiveCostReports}
          />
          {totals.unknownEffectiveCostReports === 1n ? "report" : "reports"} without cost data
        </p>
      {/if}
    {:else}
      <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">Input + output</p>
    {/if}
  </div>
  {#if view === "cost"}
    <p class="text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">Usage costs may differ from your bill.</p>
  {/if}
  <dl class="grid grid-cols-2 gap-3 sm:grid-cols-5">
    {#each counters as counter (counter.label)}
      <div class="min-w-0 rounded-xl border border-divider p-3">
        <dt class="text-sm/5 text-zinc-500 dark:text-zinc-400">{counter.label}</dt>
        <dd class="mt-1 text-base/6 font-medium wrap-anywhere tabular-nums select-text" title={count(counter.value)}>
          <AnimatedNumber value={shortCount(counter.value)} amount={counter.value} />
        </dd>
      </div>
    {/each}
  </dl>
  <p class="text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">
    Cache read and write are included in input. Reasoning is included in output. Token details depend on provider
    reports.
  </p>
</section>

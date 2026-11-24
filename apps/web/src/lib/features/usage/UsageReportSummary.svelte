<script lang="ts">
  import { getAbortSignal } from "svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import { loadUsage } from "./api.ts";
  import { count, effectiveCost, hasPartialCost, shortCount, totalTokens, type UsageData } from "./format.ts";

  let { onOpenUsage }: { onOpenUsage: () => void } = $props();

  let revision = $state(0);
  let data = $state.raw<UsageData>();
  let failed = $state(false);

  $effect(() => {
    void revision;
    const signal = getAbortSignal();
    data = undefined;
    failed = false;
    void loadUsage({ days: "30" }, signal)
      .then((result) => {
        if (!signal.aborted) data = result;
      })
      .catch(() => {
        if (!signal.aborted) failed = true;
      });
  });
</script>

<div class="grid min-w-0 gap-3 p-3">
  <header class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
    <h2 class="text-sm font-medium sm:text-xs">Usage</h2>
    <span class="text-sm text-muted sm:text-xs">Last 30 days</span>
  </header>
  {#if data}
    {#if data.totals.reports === 0n}
      <p class="text-sm/5 text-muted">No usage recorded</p>
    {:else}
      {@const tokens = totalTokens(data.totals)}
      <dl class="grid grid-cols-2 gap-3">
        <div class="min-w-0">
          <dt class="text-sm/5 text-muted sm:text-xs/5">Total tokens</dt>
          <dd class="font-semibold wrap-anywhere tabular-nums select-text" title={count(tokens)}>
            {shortCount(tokens)}
          </dd>
        </div>
        <div class="min-w-0">
          <dt class="text-sm/5 text-muted sm:text-xs/5">Cost (USD)</dt>
          <dd class="font-semibold wrap-anywhere tabular-nums select-text">{effectiveCost(data.totals)}</dd>
        </div>
      </dl>
    {/if}
    {#if hasPartialCost(data.totals)}
      <p class="text-sm/5 wrap-anywhere text-muted sm:text-xs/5">
        {count(data.totals.unknownEffectiveCostReports)}
        {data.totals.unknownEffectiveCostReports === 1n ? "report" : "reports"} without cost data
      </p>
    {:else if data.partial}
      <p class="text-sm/5 text-muted sm:text-xs/5">Some usage data may be missing.</p>
    {/if}
  {:else if failed}
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p role="status" class="text-sm/5">Could not load usage</p>
      <Button onclick={() => revision++}>Try again</Button>
    </div>
  {:else}
    <p role="status" class="text-sm/5 text-muted">Loading usage…</p>
  {/if}
  <Button variant="ghost" class="justify-start" onclick={onOpenUsage}>Open usage report</Button>
</div>

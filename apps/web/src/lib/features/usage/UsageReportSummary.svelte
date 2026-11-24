<script lang="ts">
  import { getAbortSignal } from "svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import { loadUsage } from "./api.ts";
  import { count, effectiveCost, hasPartialCost, shortCount, totalTokens, type UsageData } from "./format.ts";

  let { onOpenUsage }: { onOpenUsage: () => void } = $props();

  let revision = $state(0);
  let data = $state.raw<UsageData>();
  let failed = $state(false);
  const totals = $derived(data?.totals);
  const tokens = $derived(totals && totalTokens(totals));

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

{#snippet metric(label: string, value?: string, title?: string)}
  <div class="min-w-0">
    <dt class="text-sm/5 text-muted sm:text-xs/5">{label}</dt>
    <dd class="grid min-h-6 content-center leading-6 font-semibold wrap-anywhere tabular-nums select-text" {title}>
      {#if value !== undefined}
        {value}
      {:else}
        <Skeleton class="h-3 w-12 max-w-full" />
      {/if}
    </dd>
  </div>
{/snippet}

<div class="grid min-w-0 gap-3 p-3">
  <header class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
    <h2 class="text-sm font-medium sm:text-xs">Usage</h2>
    <span class="text-sm text-muted sm:text-xs">Last 30 days</span>
  </header>
  <!-- Reserve the two metric lines and the coverage note before the request resolves. -->
  <div class="grid min-h-19 content-start gap-3">
    {#if totals?.reports === 0n}
      <p class="text-sm/5 text-muted">No usage recorded</p>
    {:else if failed}
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p role="status" class="text-sm/5">Could not load usage</p>
        <Button onclick={() => revision++}>Try again</Button>
      </div>
    {:else}
      {#if !totals}<p role="status" class="sr-only">Loading usage…</p>{/if}
      <dl class="grid grid-cols-2 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {@render metric(
          "Total tokens",
          tokens === undefined ? undefined : shortCount(tokens),
          tokens === undefined ? undefined : count(tokens),
        )}
        {@render metric("Cost (USD)", totals && effectiveCost(totals))}
      </dl>
    {/if}
    {#if totals && hasPartialCost(totals)}
      <p class="text-sm/5 wrap-anywhere text-muted sm:text-xs/5">
        {count(totals.unknownEffectiveCostReports)}
        {totals.unknownEffectiveCostReports === 1n ? "report" : "reports"} without cost data
      </p>
    {:else if data?.partial}
      <p class="text-sm/5 text-muted sm:text-xs/5">Some usage data may be missing.</p>
    {/if}
  </div>
  <Button variant="ghost" class="justify-start" onclick={onOpenUsage}>Open usage report</Button>
</div>

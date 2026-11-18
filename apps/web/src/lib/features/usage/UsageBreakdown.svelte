<script lang="ts">
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import UsageProviderMark from "./UsageProviderMark.svelte";
  import SpeedIcon from "#lib/features/models/SpeedIcon.svelte";
  import UsageCostCoverage from "./UsageCostCoverage.svelte";
  import { estimatedCost, metricValue, reportedCost, type UsageData, type UsageRow, type UsageView } from "./format.ts";

  let { data, view }: { data: UsageData; view: UsageView } = $props();
  let group = $state("providers");

  const rows = $derived<UsageRow[]>(
    group === "models"
      ? data.models
      : group === "days"
        ? data.days.toReversed()
        : group === "speeds"
          ? data.speeds
          : data.providers,
  );
</script>

<section class="min-w-0">
  <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
    <h3 class="text-base/6 font-medium sm:text-sm/6">Breakdown</h3>
    <SegmentedChoice
      label="Group usage by"
      bind:value={group}
      options={[
        { value: "providers", label: "Provider" },
        { value: "models", label: "Model" },
        { value: "speeds", label: "Speed" },
        { value: "days", label: "Day" },
      ]}
    />
  </div>
  <div class="overflow-x-auto rounded-xl border border-divider">
    <table class="w-full text-left text-sm/5">
      <caption class="sr-only"
        >Usage by {group === "days"
          ? "day"
          : group === "models"
            ? "model"
            : group === "speeds"
              ? "requested speed"
              : "provider"}</caption
      >
      <thead class="bg-zinc-950/3 text-zinc-500 dark:bg-white/3 dark:text-zinc-400">
        <tr>
          <th scope="col" class="px-4 py-2.5 font-medium"
            >{group === "days"
              ? "Day (UTC)"
              : group === "models"
                ? "Model"
                : group === "speeds"
                  ? "Requested speed"
                  : "Provider"}</th
          >
          <th scope="col" class="px-4 py-2.5 text-right font-medium whitespace-nowrap"
            >{view === "cost" ? "Cost" : "Tokens"}</th
          >
          {#if view === "cost"}
            <th scope="col" class="px-4 py-2.5 text-right font-medium whitespace-nowrap">Reported cost</th>
            <th scope="col" class="px-4 py-2.5 text-right font-medium whitespace-nowrap">Estimated API cost</th>
            <th scope="col" class="px-4 py-2.5 text-right font-medium whitespace-nowrap">Cost coverage</th>{/if}
        </tr>
      </thead>
      <tbody class="divide-y divide-divider">
        {#each rows as row (row.key)}
          <tr>
            <th scope="row" class="max-w-40 min-w-36 px-4 py-3 font-normal sm:max-w-72">
              <div class="flex min-w-0 items-center gap-2">
                {#if group === "providers"}<UsageProviderMark provider={row.key} />{/if}
                {#if group === "speeds"}
                  {#if row.key}<SpeedIcon tier={row.key} />{:else}<span class="h-3.5 w-6 shrink-0" aria-hidden="true"
                    ></span>{/if}
                {/if}
                <TruncatedText text={row.label} />
              </div>
              {#if row.detail}<TruncatedText
                  text={row.detail}
                  class="text-xs/5 text-zinc-500 dark:text-zinc-400"
                />{/if}
            </th>
            <td class="px-4 py-3 text-right whitespace-nowrap tabular-nums select-text"
              >{metricValue(row.amounts, view)}</td
            >
            {#if view === "cost"}
              <td class="px-4 py-3 text-right whitespace-nowrap tabular-nums select-text"
                >{reportedCost(row.amounts)}</td
              >
              <td class="px-4 py-3 text-right whitespace-nowrap tabular-nums select-text"
                >{estimatedCost(row.amounts)}</td
              >
              <td class="min-w-40 px-4 py-3 text-right"><UsageCostCoverage amounts={row.amounts} /></td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<script lang="ts">
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import UsageProviderMark from "./UsageProviderMark.svelte";
  import SpeedIcon from "#lib/features/models/SpeedIcon.svelte";
  import { compareUsage, metricValue, type UsageData, type UsageView } from "./format.ts";

  let { data, view, group = $bindable() }: { data: UsageData; view: UsageView; group: string } = $props();

  const providerGroup = $derived({ value: "providers", label: "Provider", heading: "Provider", rows: data.providers });

  const groups = $derived([
    ...(data.supportsWorkerBreakdown && data.workers.length
      ? [
          {
            value: "workers",
            label: "Worker",
            heading: "Worker",
            rows: data.workers.toSorted((a, b) => compareUsage(a, b, view)),
          },
        ]
      : []),
    providerGroup,
    { value: "models", label: "Model", heading: "Model", rows: data.models },
    { value: "speeds", label: "Speed", heading: "Requested speed", rows: data.speeds },
    { value: "days", label: "Day", heading: "Day (UTC)", rows: data.days.toReversed() },
    ...(data.supportsActivityBreakdown && data.bots.length
      ? [{ value: "bots", label: "Bot", heading: "Bot", rows: data.bots.toSorted((a, b) => compareUsage(a, b, view)) }]
      : []),
  ]);

  const selection = $derived(groups.find((option) => option.value === group) ?? providerGroup);
</script>

<section class="min-w-0">
  <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
    <h3 class="text-base/6 font-medium sm:text-sm/6">Breakdown</h3>
    <SegmentedChoice
      label="Group usage by"
      bind:value={() => selection.value, (value) => (group = value)}
      options={groups}
      class="flex-wrap"
    />
  </div>
  <div class="overflow-x-auto rounded-xl border border-divider">
    <table class="w-full text-left text-sm/5">
      <caption class="sr-only">Usage by {selection.value === "days" ? "day" : selection.heading.toLowerCase()}</caption>
      <thead class="bg-zinc-950/3 text-zinc-500 dark:bg-white/3 dark:text-zinc-400">
        <tr>
          <th scope="col" class="px-4 py-2.5 font-medium">{selection.heading}</th>
          <th scope="col" class="px-4 py-2.5 text-right font-medium whitespace-nowrap"
            >{view === "cost" ? "Cost" : "Tokens"}</th
          >
        </tr>
      </thead>
      <tbody class="divide-y divide-divider">
        {#each selection.rows as row (row.key)}
          <tr>
            <th scope="row" class="w-full max-w-0 min-w-28 px-4 py-3 font-normal sm:min-w-36">
              <div class="flex min-w-0 items-center gap-2">
                {#if selection.value === "providers"}<UsageProviderMark provider={row.key} />{/if}
                {#if selection.value === "speeds"}
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
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

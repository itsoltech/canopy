<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import { metricValue, usageActivities, type UsageRow, type UsageView } from "./format.ts";

  let { rows, view, class: className }: { rows: UsageRow[]; view: UsageView; class?: ClassValue } = $props();

  const activities = $derived(
    usageActivities.flatMap(({ value, label }) => {
      const row = rows.find((item) => item.key === value);

      return row || value === "thread" || value === "bot" ? [{ value, label, amounts: row?.amounts }] : [];
    }),
  );
</script>

<section class={["@container grid min-w-0 gap-3", className]}>
  <h3 class="text-base/6 font-medium sm:text-sm/6">Usage by activity</h3>
  <dl
    class={[
      "grid grid-cols-2 gap-3",
      activities.length === 3 && "@xl:grid-cols-3",
      activities.length === 4 && "@xl:grid-cols-4",
    ]}
  >
    {#each activities as { value, label, amounts } (value)}
      <div class="grid min-w-0 content-start gap-1 rounded-xl border border-divider p-3">
        <dt class="text-sm/5 text-zinc-500 dark:text-zinc-400"><TruncatedText text={label} /></dt>
        <dd class="text-base/6 font-medium wrap-anywhere tabular-nums select-text">
          {amounts ? metricValue(amounts, view) : "None recorded"}
        </dd>
      </div>
    {/each}
  </dl>
</section>

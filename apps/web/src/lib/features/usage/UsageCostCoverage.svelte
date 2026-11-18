<script lang="ts">
  import { count, type UsageAmounts } from "./format.ts";

  let { amounts }: { amounts: UsageAmounts } = $props();
</script>

<span class="flex flex-wrap justify-end gap-x-3 gap-y-0.5 text-xs/5 text-zinc-500 tabular-nums dark:text-zinc-400">
  <span>{count(amounts.effectiveReportedCostReports)} reported</span>
  <span>{count(amounts.effectiveEstimatedCostReports)} estimated</span>
  <span>{count(amounts.unknownEffectiveCostReports)} unknown</span>
</span>

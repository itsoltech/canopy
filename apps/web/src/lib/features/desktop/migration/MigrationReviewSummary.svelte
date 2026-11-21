<script lang="ts">
  import type { DesktopMigrationReview } from "@canopy/ui/desktop";
  import { reviewKind } from "./migration-copy.ts";

  let { review }: { review: DesktopMigrationReview } = $props();

  const counts = $derived(
    ["projects", "threads", "bots", "schedules", "workers", "attachments"]
      .values()
      .map((table) => ({ label: reviewKind(table), count: review.counts[table] ?? 0 }))
      .filter(({ count }) => count > 0)
      .toArray(),
  );
</script>

{#if counts.length}
  <dl class="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3">
    {#each counts as { label, count } (label)}
      <div class="min-w-0 rounded-lg bg-panel px-3 py-2">
        <dt class="text-sm/5 text-muted">{label}</dt>
        <dd class="font-medium tabular-nums">{count.toLocaleString()}</dd>
      </div>
    {/each}
  </dl>
{/if}

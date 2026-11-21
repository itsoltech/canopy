<script lang="ts">
  import type { DesktopMigrationStatus } from "@canopy/ui/desktop";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import { formatBytes, formatDuration } from "#lib/shared/format.ts";
  import MigrationBlockers from "./MigrationBlockers.svelte";
  import MigrationReviewSummary from "./MigrationReviewSummary.svelte";

  let { preparation, joining }: { preparation?: DesktopMigrationStatus["preparation"]; joining: boolean } = $props();

  const review = $derived(preparation?.review);
</script>

<section class="grid min-w-0 gap-3" aria-labelledby="migration-trial">
  <div class="grid gap-1">
    <h2 class="text-lg/7 font-semibold" id="migration-trial">Trial complete</h2>
    {#if joining}
      <p class="text-pretty text-muted">
        Canopy waits for active work to finish, then pauses this gateway. Review the final snapshot before sharing its
        data with devices connected to the server’s Canopy account.
      </p>
    {:else}
      <p class="text-pretty text-muted">
        The server restored a trial copy. The switch waits for active work to finish, then takes a fresh copy. Existing
        devices may need the server’s address to reconnect.
      </p>
    {/if}
  </div>
  {#if preparation}
    <dl class="flex flex-wrap gap-x-6 gap-y-1">
      <div class="flex items-baseline gap-2">
        <dt class="text-muted">Trial time</dt>
        <dd class="font-medium tabular-nums">{formatDuration(preparation.durationMs)}</dd>
      </div>
      {#if preparation.databaseBytes !== undefined}
        <div class="flex items-baseline gap-2">
          <dt class="text-muted">Source database size</dt>
          <dd class="font-medium tabular-nums">{formatBytes(preparation.databaseBytes)}</dd>
        </div>
      {/if}
    </dl>
    {#if preparation.routes?.length}
      <Disclosure>
        {#snippet summary()}Show server addresses{/snippet}
        <ul class="grid gap-1 pt-2 pl-6 wrap-anywhere text-muted">
          {#each preparation.routes as route (route)}<li>{route}</li>{/each}
        </ul>
      </Disclosure>
    {/if}
  {/if}
  {#if review}
    <MigrationReviewSummary {review} />
    <MigrationBlockers blockers={review.blockers} />
  {/if}
</section>

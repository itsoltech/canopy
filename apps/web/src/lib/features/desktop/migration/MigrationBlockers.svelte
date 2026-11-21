<script lang="ts">
  import type { DesktopMigrationReview } from "@canopy/ui/desktop";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import { reviewBlocker, reviewKind } from "./migration-copy.ts";

  let {
    blockers,
    final = false,
    canAbort = true,
  }: { blockers: DesktopMigrationReview["blockers"]; final?: boolean; canAbort?: boolean } = $props();
</script>

{#if blockers.length}
  <Alert tone="warning" title="The server found items that block this import">
    {#if !canAbort}
      Keep the local gateway paused. Ask the server administrator to resolve these items.
    {:else if final}
      Cancel the migration to resume local work. Resolve these items before starting a new trial.
    {:else}
      Cancel the trial, resolve these items, then run a new trial.
    {/if}
  </Alert>
  <Disclosure open>
    {#snippet summary()}{blockers.length.toLocaleString()} {blockers.length === 1 ? "blocker" : "blockers"}{/snippet}
    <ul class="mt-2 ml-6 max-h-60 scroll-stable divide-y divide-divider overflow-y-auto">
      {#each blockers as { table, key, reason }}
        <li class="py-2">
          <p class="font-medium">{reviewKind(table)}</p>
          <p class="text-muted">{reviewBlocker(reason)}</p>
          <p class="text-sm wrap-anywhere text-muted">{key}</p>
        </li>
      {/each}
    </ul>
  </Disclosure>
{/if}

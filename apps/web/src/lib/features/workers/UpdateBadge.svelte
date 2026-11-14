<script lang="ts">
  import Badge from "#lib/shared/ui/Badge.svelte";
  import { updateBadge, type UpdateStatus } from "@canopy/domain/release/update-status";

  /** One status word per update row (docs/updates.md): settled is quiet text, attention gets a pill. */
  let { status }: { status: UpdateStatus | string } = $props();
  const badge = $derived(updateBadge(status));
</script>

{#key badge.label}
  {#if badge.tone === "quiet"}<span class="t-swap text-sm/5 whitespace-nowrap text-muted select-none sm:text-xs/4"
      >{badge.label}</span
    >{:else}<Badge compact tone={badge.tone} class="t-swap">{badge.label}</Badge>{/if}
{/key}

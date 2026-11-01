<script lang="ts">
  import Badge from "#lib/shared/ui/Badge.svelte";

  /** Marks threads an agent started (agent bus), as opposed to ones you started. */
  let { compact = false }: { compact?: boolean } = $props();
</script>

{#if compact}
  <span class="inline-flex shrink-0 items-center rounded-sm bg-violet-50 px-1 text-xs/5 font-medium text-violet-700 dark:bg-violet-400/10 dark:text-violet-300">agent</span>
{:else}
  <Badge tone="violet" icon="sparkles">Started by agent</Badge>
{/if}

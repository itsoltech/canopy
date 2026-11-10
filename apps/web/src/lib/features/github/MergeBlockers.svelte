<script lang="ts">
  import { mergeBlocker } from "@canopy/domain/github-lifecycle-display";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";

  let { reasons }: { reasons: string[] } = $props();
  let expanded = $state(false);
  const visible = $derived((expanded ? reasons : reasons.slice(0, 2)).map(mergeBlocker));
</script>

{#if reasons.length}
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm/5 text-zinc-500 dark:text-zinc-400">
    <span class="font-medium">Merging blocked</span>
    {#each visible as reason}
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded focus-ring"
        {@attach tooltip(reason.detail, { touch: "tap" })}
      >
        <Icon name={reason.icon} />{reason.label}
      </button>
    {/each}
    {#if reasons.length > 2}
      <Button size="sm" variant="ghost" aria-expanded={expanded} onclick={() => (expanded = !expanded)}
        >{expanded ? "Show less" : `+${reasons.length - 2} more`}</Button
      >
    {/if}
  </div>
{/if}

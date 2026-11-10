<script lang="ts">
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { labelColors } from "@canopy/domain/github-pr";
  import Button from "#lib/shared/ui/Button.svelte";

  let { snapshot, class: className }: { snapshot: github.PullRequestSnapshot; class?: ClassValue } = $props();
  let expanded = $state(false);

  const labels = $derived(
    snapshot.labelDetails.length ? snapshot.labelDetails : snapshot.labels.map((name) => ({ name, color: "" })),
  );
</script>

{#if labels.length}
  <div aria-label="Labels" class={["flex min-w-0 flex-wrap items-center gap-1.5 text-sm/5 sm:text-xs/5", className]}>
    {#each expanded ? labels : labels.slice(0, 4) as label, i (`${label.name}:${i}`)}
      {@const colors = labelColors(label.color)}
      <span
        title={label.name}
        class="max-w-44 truncate rounded-md bg-(--label-bg) px-2 py-0.5 font-medium text-(--label-ink) ring-1 ring-black/10 ring-inset dark:ring-white/15"
        style:--label-bg={colors.background}
        style:--label-ink={colors.foreground}>{label.name}</span
      >
    {/each}
    {#if labels.length > 4}<Button
        size="sm"
        variant="ghost"
        aria-label={expanded ? "Show fewer labels" : `Show ${labels.length - 4} more labels`}
        aria-expanded={expanded}
        onclick={() => (expanded = !expanded)}>{expanded ? "Show less" : `+${labels.length - 4}`}</Button
      >{/if}
  </div>
{/if}

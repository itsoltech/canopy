<script lang="ts">
  import type { Item, ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import { rise } from "#lib/shared/ui/motion.ts";
  import InteractionCard from "./InteractionCard.svelte";

  let {
    interactions,
    items,
    parent,
    class: className,
  }: { interactions: ui.Interaction[]; items: Map<string, Item>; parent?: ui.Thread; class?: ClassValue } = $props();

  let selected = $state<string>();

  const index = $derived(
    Math.max(
      0,
      interactions.findIndex((interaction) => interaction.requestId === selected),
    ),
  );
</script>

<div class={["grid gap-2", className]}>
  {#if interactions.length > 1}
    <div class="flex items-center justify-between gap-2 text-sm/5 text-zinc-500 tabular-nums dark:text-zinc-400">
      <p aria-live="polite">Request {index + 1} of {interactions.length}</p>
      <div class="flex gap-1">
        {#if index > 0}<Button size="sm" variant="ghost" onclick={() => (selected = interactions[index - 1]?.requestId)}
            >Previous</Button
          >{/if}
        {#if index + 1 < interactions.length}<Button
            size="sm"
            variant="ghost"
            onclick={() => (selected = interactions[index + 1]?.requestId)}>Next request</Button
          >{/if}
      </div>
    </div>
  {/if}
  {#each interactions as interaction, position (interaction.requestId)}
    <div class={position !== index ? "hidden" : undefined} in:rise>
      <InteractionCard {interaction} related={items.get(interaction.itemId)} {parent} />
    </div>
  {/each}
</div>

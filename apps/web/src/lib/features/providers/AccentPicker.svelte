<script lang="ts">
  import Fieldset from "#lib/shared/ui/Fieldset.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { accentColors } from "./instances.ts";

  /** Optional accent color of an instance (a dot on its mark in lists and in the model picker). */
  let { value = $bindable(""), name }: { value: string; name: string } = $props();
  const swatch =
    "relative grid size-8 place-items-center rounded-full ring-1 ring-zinc-950/10 has-checked:ring-2 has-checked:ring-zinc-950 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-brand-500 sm:size-7 dark:ring-white/15 dark:has-checked:ring-white";
</script>

<Fieldset legend="Accent color" description="Optional. Marks the instance in the model picker.">
  <div class="flex flex-wrap gap-2">
    <label class={[swatch, "bg-white dark:bg-white/5"]}>
      <input type="radio" {name} value="" class="sr-only" bind:group={value} aria-label="No color" />
      <Icon name="no-symbol" class="size-4 fill-zinc-400" />
    </label>
    {#each accentColors as color (color)}
      <label class={swatch} style:background-color={color}>
        <input type="radio" {name} value={color} class="sr-only" bind:group={value} aria-label="Color {color}" />
      </label>
    {/each}
  </div>
</Fieldset>

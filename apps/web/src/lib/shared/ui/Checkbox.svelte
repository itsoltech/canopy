<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import ChoiceControl from "./ChoiceControl.svelte";
  import { useDensity } from "./density.ts";
  import TruncatedText from "./TruncatedText.svelte";

  /**
   * Checkbox with a label and an optional description, aligned with the first line of the label. `aside`
   * follows the label on its line (e.g. badges).
   */
  let {
    name,
    label,
    description,
    checked = $bindable(false),
    disabled = false,
    value = "on",
    class: className,
    aside,
  }: {
    name: string;
    label: string;
    description?: string | undefined;
    checked?: boolean;
    disabled?: boolean;
    value?: string;
    class?: ClassValue;
    aside?: Snippet;
  } = $props();

  const id = $props.id();
  const overlay = useDensity() === "overlay";
</script>

<div
  class={[
    "ui-checkbox flex",
    overlay ? "gap-2 text-base/6 sm:text-sm/5" : "gap-3 text-base/6 sm:text-sm/6 pointer-coarse:min-h-12",
    className,
  ]}
>
  <div class="flex h-lh items-center">
    <ChoiceControl
      {id}
      type="checkbox"
      {name}
      {value}
      {disabled}
      bind:checked
      aria-describedby={description ? `${id}-description` : undefined}
    />
  </div>
  <div class="min-w-0">
    {#if aside}
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <label for={id} class="font-medium text-zinc-950 dark:text-white">{label}</label>
        {@render aside()}
      </div>
    {:else if overlay}
      <!-- An overlay row stays one line: a long name ends in an ellipsis, the tooltip has it in full. -->
      <label for={id} class="block font-medium text-zinc-950 dark:text-white"><TruncatedText text={label} /></label>
    {:else}
      <label for={id} class="font-medium text-zinc-950 dark:text-white">{label}</label>
    {/if}
    {#if description}<p id="{id}-description" class="text-zinc-500 dark:text-zinc-400">{description}</p>{/if}
  </div>
</div>

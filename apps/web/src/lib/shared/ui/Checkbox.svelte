<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import ChoiceControl from "./ChoiceControl.svelte";

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
</script>

<div class={["ui-checkbox flex gap-3 pointer-coarse:min-h-12", className]}>
  <div class="flex h-lh items-center text-base/6 sm:text-sm/6">
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
  <div class="min-w-0 text-base/6 sm:text-sm/6">
    {#if aside}
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <label for={id} class="font-medium text-zinc-950 dark:text-white">{label}</label>
        {@render aside()}
      </div>
    {:else}
      <label for={id} class="font-medium text-zinc-950 dark:text-white">{label}</label>
    {/if}
    {#if description}<p id="{id}-description" class="text-zinc-500 dark:text-zinc-400">{description}</p>{/if}
  </div>
</div>

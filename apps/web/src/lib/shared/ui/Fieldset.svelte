<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import FieldError from "./FieldError.svelte";

  /**
   * A group of controls under one heading (radio cards, checkboxes, a list editor): a fieldset whose legend looks
   * like a `Field` label, with an optional description and error.
   */
  let {
    legend,
    description,
    error,
    disabled = false,
    class: className,
    children,
  }: {
    legend: string;
    description?: string;
    error?: string | undefined;
    disabled?: boolean;
    class?: ClassValue;
    children: Snippet;
  } = $props();
</script>

<fieldset class={className} {disabled}>
  <!-- A rendered legend is not a grid item: the layout lives in the wrapper below it. -->
  <legend class="text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">{legend}</legend>
  {#if description}<p class="text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">{description}</p>{/if}
  <div class="ui-fieldset-content mt-2 grid gap-2">
    {@render children()}
    <FieldError message={error} />
  </div>
</fieldset>

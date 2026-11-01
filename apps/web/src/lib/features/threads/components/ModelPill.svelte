<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  /**
   * Free-text model as a composer pill (no model catalog in the contract): grows with its value,
   * suggests models used before, empty = the profile's default model.
   */
  let {
    value = $bindable(""),
    suggestions = [],
    name = "model",
    label = "Model",
    class: className,
  }: { value?: string; suggestions?: readonly string[]; name?: string; label?: string; class?: ClassValue } = $props();
  const id = $props.id();
</script>

<input
  {name}
  type="text"
  list="{id}-models"
  aria-label={label}
  title={label}
  placeholder="Default model"
  autocomplete="off"
  spellcheck="false"
  bind:value
  class={[
    "max-w-[24ch] min-w-[13ch] rounded-lg bg-transparent px-2 py-1.5 text-base/5 text-zinc-600 [field-sizing:content] placeholder:text-zinc-400 hover:bg-zinc-950/5 hover:text-zinc-950 focus:bg-zinc-950/5 focus:text-zinc-950 focus:outline-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-brand-500 sm:text-[0.8125rem]/5 dark:text-zinc-400 dark:placeholder:text-zinc-500 dark:hover:bg-white/5 dark:hover:text-white dark:focus:bg-white/5 dark:focus:text-white",
    className,
  ]}
/>
<datalist id="{id}-models">
  {#each suggestions as model (model)}<option value={model}></option>{/each}
</datalist>

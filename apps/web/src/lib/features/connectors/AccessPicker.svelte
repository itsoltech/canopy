<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Fieldset from "#lib/shared/ui/Fieldset.svelte";

  let {
    label,
    all = $bindable(false),
    selected = $bindable([]),
    options,
    disabled = false,
    class: className,
  }: {
    label: string;
    all?: boolean;
    selected?: string[];
    options: readonly { id: string; name: string }[];
    disabled?: boolean;
    class?: ClassValue;
  } = $props();
</script>

<Fieldset legend={label} {disabled} class={className}>
  <Checkbox
    name="all-{label}"
    label="All {label.toLowerCase()}"
    description="Including those added later."
    bind:checked={all}
  />
  {#if !all}
    <div class="grid max-h-56 gap-3 overflow-y-auto py-1 pl-7">
      {#each options as option (option.id)}
        <Checkbox
          name="grant-{option.id}"
          label={option.name}
          bind:checked={
            () => selected.includes(option.id),
            (on) => (selected = on ? [...selected, option.id] : selected.filter((id) => id !== option.id))
          }
        />
      {:else}<p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          No {label.toLowerCase()} yet.
        </p>{/each}
    </div>
  {/if}
</Fieldset>

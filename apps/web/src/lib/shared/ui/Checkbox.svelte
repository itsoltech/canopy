<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

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

<div class={["flex gap-3", className]}>
  <div class="flex h-lh items-center text-base/6 sm:text-sm/6">
    <span class="group inline-grid size-5 grid-cols-1 sm:size-4">
      <input
        {id}
        type="checkbox"
        {name}
        {value}
        {disabled}
        bind:checked
        aria-describedby={description ? `${id}-description` : undefined}
        class="col-start-1 row-start-1 appearance-none rounded-sm border border-zinc-300 bg-white checked:border-brand-600 checked:bg-brand-600 indeterminate:border-brand-600 indeterminate:bg-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:border-zinc-300 disabled:bg-zinc-100 disabled:checked:bg-zinc-100 dark:border-white/10 dark:bg-white/5 dark:checked:border-brand-500 dark:checked:bg-brand-500 dark:indeterminate:border-brand-500 dark:indeterminate:bg-brand-500 dark:disabled:border-white/5 dark:disabled:bg-white/10 dark:disabled:checked:bg-white/10 forced-colors:appearance-auto"
      />
      <svg viewBox="0 0 14 14" fill="none" class="pointer-events-none col-start-1 row-start-1 size-7/8 self-center justify-self-center stroke-white group-has-disabled:stroke-zinc-950/25 dark:group-has-disabled:stroke-white/25" aria-hidden="true">
        <path d="M3 8L6 11L11 3.5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="group-not-has-checked:opacity-0" />
      </svg>
    </span>
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

<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { useDensity } from "./density.ts";
  import TouchTarget from "./TouchTarget.svelte";
  import { tooltip } from "./tooltip.ts";

  /**
   * On/off switch on a native checkbox (state in CSS only). Larger on touch screens. The thumb travels on
   * --duration-fast with --ease-smooth-out (toggle, 27); no motion with reduced motion.
   */
  let {
    checked = $bindable(false),
    indeterminate = false,
    label,
    description,
    name,
    size = "md",
    disabled = false,
    onchange,
    class: className,
  }: {
    checked?: boolean;
    /** Mixed access across several items; clicking enables all items. */
    indeterminate?: boolean;
    label: string;
    description?: string;
    name: string;
    /** Compact visual for dense rows; the touch target stays at least 48 px. */
    size?: "sm" | "md";
    disabled?: boolean;
    onchange?: (checked: boolean) => void;
    class?: ClassValue;
  } = $props();

  let input: HTMLInputElement;

  // Overlays (docs/ui-scale.md): 36 × 20 px on touch screens, 28 × 16 px from `sm`.
  const density = useDensity();
  const width = $derived(size === "sm" ? "w-8 sm:w-7" : density === "overlay" ? "w-9 sm:w-7" : "w-11 sm:w-9");
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<span
  onclick={(event) => {
    if (event.target !== input) {
      event.preventDefault();
      input.click();
      input.focus();
    }
  }}
  class={[
    "group relative inline-flex shrink-0 rounded-full bg-zinc-200 p-0.5 inset-ring inset-ring-zinc-900/5 outline-offset-2 outline-brand-600 transition-colors duration-(--duration-fast) ease-smooth-out has-checked:bg-brand-600 has-indeterminate:bg-brand-600/35 has-focus-visible:outline-2 has-disabled:opacity-50 motion-reduce:transition-none dark:bg-white/5 dark:inset-ring-white/10 dark:outline-brand-500 dark:has-checked:bg-brand-500 dark:has-indeterminate:bg-brand-500/35",
    width,
    className,
  ]}
>
  <span
    class="flex aspect-square w-1/2 items-center justify-center rounded-full bg-white shadow-xs ring-1 ring-zinc-900/5 transition-transform duration-(--duration-fast) ease-smooth-out group-has-checked:translate-x-full group-has-checked:bg-on-control group-has-indeterminate:translate-x-1/2 motion-reduce:transition-none"
    >{#if indeterminate}<span class="h-px w-1.5 bg-zinc-500"></span>{/if}</span
  >
  <input
    bind:this={input}
    type="checkbox"
    {name}
    aria-label={label}
    {@attach tooltip(description)}
    {disabled}
    {indeterminate}
    bind:checked
    onchange={(event) => {
      const value = indeterminate || event.currentTarget.checked;
      event.currentTarget.indeterminate = indeterminate;
      onchange?.(value);
    }}
    class="absolute inset-0 size-full cursor-pointer appearance-none focus:outline-hidden disabled:cursor-not-allowed"
  />
  <TouchTarget />
</span>

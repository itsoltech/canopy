<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import TouchTarget from "./TouchTarget.svelte";

  /**
   * On/off switch on a native checkbox (state in CSS only). Larger on touch screens. The thumb travels on
   * --duration-fast with --ease-smooth-out (toggle, 27); no motion with reduced motion.
   */
  let {
    checked = $bindable(false),
    label,
    name,
    disabled = false,
    onchange,
    class: className,
  }: {
    checked?: boolean;
    label: string;
    name: string;
    disabled?: boolean;
    onchange?: (checked: boolean) => void;
    class?: ClassValue;
  } = $props();

  let input: HTMLInputElement;
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
    "group relative inline-flex w-11 shrink-0 rounded-full bg-zinc-200 p-0.5 inset-ring inset-ring-zinc-900/5 outline-offset-2 outline-brand-600 transition-colors duration-(--duration-fast) ease-smooth-out has-checked:bg-brand-600 has-focus-visible:outline-2 has-disabled:opacity-50 motion-reduce:transition-none sm:w-9 dark:bg-white/5 dark:inset-ring-white/10 dark:outline-brand-500 dark:has-checked:bg-brand-500",
    className,
  ]}
>
  <span
    class="aspect-square w-1/2 rounded-full bg-white shadow-xs ring-1 ring-zinc-900/5 transition-transform duration-(--duration-fast) ease-smooth-out group-has-checked:translate-x-full motion-reduce:transition-none"
  ></span>
  <input
    bind:this={input}
    type="checkbox"
    {name}
    aria-label={label}
    {disabled}
    bind:checked
    onchange={(event) => onchange?.(event.currentTarget.checked)}
    class="absolute inset-0 size-full cursor-pointer appearance-none focus:outline-hidden disabled:cursor-not-allowed"
  />
  <TouchTarget />
</span>

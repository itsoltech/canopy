<script lang="ts">
  import type { ClassValue, HTMLInputAttributes } from "svelte/elements";
  import TouchTarget from "./TouchTarget.svelte";

  /** Shared drawn checkbox/radio. The semantic input retains focus, forms and native radio keys.
   * Forced-colors intentionally restores the OS control for high-contrast accessibility. */
  type Props = Omit<HTMLInputAttributes, "class" | "type"> & { type?: "checkbox" | "radio"; class?: ClassValue };
  let { type = "checkbox", class: className, checked = $bindable(false), onchange, ...rest }: Props = $props();
  let input: HTMLInputElement;
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<span class={["group relative inline-grid size-5 shrink-0 grid-cols-1 sm:size-4", className]} onclick={(event) => {
  if (event.target === input) return;
  event.preventDefault(); input.click(); input.focus();
}}>
  <input bind:this={input} {type} {...rest} {checked} onchange={(event) => { checked = event.currentTarget.checked; onchange?.(event); }}
    class={["col-start-1 row-start-1 size-full appearance-none border border-zinc-300 bg-white checked:border-brand-600 checked:bg-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:opacity-50 dark:border-white/15 dark:bg-white/5 dark:checked:border-brand-500 dark:checked:bg-brand-500 forced-colors:appearance-auto",
      type === "radio" ? "rounded-full" : "rounded-sm"]} />
  {#if type === "radio"}
    <span class="pointer-events-none col-start-1 row-start-1 size-2 self-center justify-self-center rounded-full bg-white group-not-has-checked:opacity-0 forced-colors:hidden"></span>
  {:else}
    <svg viewBox="0 0 14 14" fill="none" class="pointer-events-none col-start-1 row-start-1 size-7/8 self-center justify-self-center stroke-white group-has-disabled:opacity-60 group-not-has-checked:opacity-0 forced-colors:hidden" aria-hidden="true">
      <path d="M3 8L6 11L11 3.5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  {/if}
  <TouchTarget />
</span>

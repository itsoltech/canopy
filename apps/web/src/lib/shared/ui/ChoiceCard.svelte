<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Radio from "./Radio.svelte";

  /**
   * A radio option as a card: title and description, highlighted while chosen. Shows its radio unless a `leading`
   * mark stands in for it (the input is then visually hidden but still focusable; the card shows the focus ring).
   */
  let {
    name,
    checked,
    title,
    description,
    onchange,
    class: className,
    leading,
  }: {
    name: string;
    checked: boolean;
    title: string;
    description?: string;
    onchange: () => void;
    class?: ClassValue;
    leading?: Snippet;
  } = $props();
</script>

<label
  class={[
    "flex min-h-12 gap-3 rounded-xl p-3 ring-1 ring-zinc-950/10 has-checked:bg-brand-50/50 has-checked:ring-brand-600/40 has-focus-visible:outline-2 has-focus-visible:outline-brand-500 dark:ring-white/10 dark:has-checked:bg-brand-500/10 dark:has-checked:ring-brand-500/40",
    leading && "items-center",
    className,
  ]}
>
  {#if leading}
    <input type="radio" {name} class="sr-only" {checked} {onchange} />
    {@render leading()}
  {:else}
    <span class="flex h-lh items-center text-base/6 sm:text-sm/6"><Radio {name} {checked} {onchange} /></span>
  {/if}
  <span class="min-w-0 text-base/6 sm:text-sm/6">
    <span class="font-medium text-zinc-950 dark:text-white">{title}</span>
    {#if description}<span class="block text-pretty text-zinc-500 dark:text-zinc-400">{description}</span>{/if}
  </span>
</label>

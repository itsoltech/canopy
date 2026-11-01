<script lang="ts" generics="T extends string">
  import type { ClassValue } from "svelte/elements";

  /** Gallery switch between a few values (buttons with aria-pressed). */
  let { options, value = $bindable(), label, class: className }: { options: readonly { value: T; label: string }[]; value: T; label: string; class?: ClassValue } = $props();
</script>

<div role="group" aria-label={label} class={["inline-flex gap-0.5 rounded-lg bg-zinc-950/5 p-0.5 dark:bg-white/5", className]}>
  {#each options as option (option.value)}
    <button
      type="button"
      aria-pressed={value === option.value}
      class="rounded-md px-3 py-1.5 text-base/6 font-medium text-zinc-500 hover:text-zinc-950 focus-ring aria-pressed:bg-white aria-pressed:text-zinc-950 aria-pressed:shadow-xs sm:py-1 sm:text-sm/6 dark:text-zinc-400 dark:hover:text-white dark:aria-pressed:bg-white/10 dark:aria-pressed:text-white dark:aria-pressed:shadow-none"
      onclick={() => (value = option.value)}
    >
      {option.label}
    </button>
  {/each}
</div>

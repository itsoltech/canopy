<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /**
   * Compact native `<select>` styled as a pill (model, permissions, workspace). Native for keyboard
   * and screen readers; the visible label is the selected option.
   */
  let {
    value = $bindable(),
    name,
    label,
    class: className,
    children,
  }: { value?: unknown; name: string; label: string; class?: ClassValue; children: Snippet } = $props();
</script>

<span class={["relative inline-grid min-w-0 grid-cols-[1fr_--spacing(5)]", className]}>
  <select
    {name}
    aria-label={label}
    bind:value
    class="col-span-full row-start-1 min-w-0 appearance-none truncate rounded-lg bg-transparent py-1.5 pr-6 pl-2 text-sm/5 text-zinc-600 hover:bg-zinc-950/5 hover:text-zinc-950 focus-ring sm:text-[0.8125rem]/5 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white dark:[&_option]:bg-zinc-900"
  >
    {@render children()}
  </select>
  <svg viewBox="0 0 8 5" width="8" height="5" fill="none" class="pointer-events-none col-start-2 row-start-1 place-self-center stroke-zinc-400 dark:stroke-zinc-500" aria-hidden="true">
    <path d="M.5.5 4 4 7.5.5" />
  </svg>
</span>

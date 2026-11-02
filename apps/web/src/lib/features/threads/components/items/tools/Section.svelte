<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** A labelled part of a tool's details ("Result", "Script", "Prompt"); `aside` sits right of the label. */
  let { label, aside, class: className, children }: { label: string; aside?: Snippet; class?: ClassValue; children: Snippet } = $props();
</script>

<section class={["grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1", className]} aria-label={label}>
  <div data-quote-skip class="flex items-center justify-between gap-3 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
    <h4 class="font-medium">{label}</h4>
    {@render aside?.()}
  </div>
  {@render children()}
</section>

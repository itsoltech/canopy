<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  /** Short numbered setup steps. */
  let { steps, class: className }: { steps: readonly string[]; class?: ClassValue } = $props();
</script>

<ol class={["grid gap-1.5 text-zinc-600 dark:text-zinc-300", className]}>
  {#each steps as step, index (index)}
    <li class="flex gap-2.5">
      <span class="flex h-lh shrink-0 items-center"
        ><span
          class="flex size-5 items-center justify-center rounded-full bg-zinc-950/5 text-xs/4 font-medium text-zinc-700 tabular-nums dark:bg-white/10 dark:text-zinc-200"
          >{index + 1}</span
        ></span
      >
      <span class="min-w-0 text-pretty">{step}</span>
    </li>
  {/each}
</ol>

<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  let {
    title,
    description,
    children,
    class: className,
  }: { title: string; description?: string; children: Snippet; class?: ClassValue } = $props();
</script>

<section
  aria-label={title}
  class={["grid gap-4 border-t border-zinc-950/10 py-6 first:border-0 first:pt-0 dark:border-white/10", className]}
>
  <div class="grid gap-1">
    <h3 class="text-base font-semibold text-balance">{title}</h3>
    {#if description}<p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        {description}
      </p>{/if}
  </div>
  {@render children()}
</section>

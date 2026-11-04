<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** One block of the gallery: a heading, a line about it, and the specimens. */
  let {
    title,
    description,
    children,
    class: className,
  }: { title: string; description?: string; children: Snippet; class?: ClassValue } = $props();

  const id = $props.id();
</script>

<section aria-labelledby={id} class={["grid gap-4 border-t border-zinc-950/5 pt-8 dark:border-white/10", className]}>
  <div>
    <h2 {id} class="text-base/7 font-semibold text-zinc-950 dark:text-white">{title}</h2>
    {#if description}<p class="max-w-[65ch] text-base/7 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        {description}
      </p>{/if}
  </div>
  {@render children()}
</section>

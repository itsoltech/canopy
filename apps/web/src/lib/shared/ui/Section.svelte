<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** Titled block of a page. The heading names the region for assistive tech. */
  let {
    title,
    description,
    class: className,
    actions,
    children,
  }: { title: string; description?: string; class?: ClassValue; actions?: Snippet; children: Snippet } = $props();
  const id = $props.id();
</script>

<section class={className} aria-labelledby={id}>
  <div class="flex items-end justify-between gap-4">
    <div class="min-w-0">
      <h2 {id} class="text-base/7 font-semibold text-zinc-950 dark:text-white">{title}</h2>
      {#if description}<p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">{description}</p>{/if}
    </div>
    {#if actions}<div class="flex shrink-0 items-center gap-2">{@render actions()}</div>{/if}
  </div>
  <div class="mt-4">{@render children()}</div>
</section>

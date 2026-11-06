<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** One flat section of an expanded worker: a heading, optional actions beside it, and its content. No card of its own. */
  let {
    title,
    description,
    class: className,
    actions,
    children,
  }: { title: string; description?: string; class?: ClassValue; actions?: Snippet; children: Snippet } = $props();

  const id = $props.id();
</script>

<section class={["grid min-w-0 gap-3 px-4 py-4 sm:px-5", className]} aria-labelledby={id}>
  <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
    <div class="min-w-0">
      <h3 {id} class="text-base/6 font-semibold text-zinc-950 sm:text-sm/6 dark:text-white">{title}</h3>
      {#if description}<p class="text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">{description}</p>{/if}
    </div>
    {#if actions}<div class="flex shrink-0 items-center gap-2">{@render actions()}</div>{/if}
  </div>
  {@render children()}
</section>

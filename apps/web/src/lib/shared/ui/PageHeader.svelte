<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** Page title with optional eyebrow (e.g. breadcrumbs), description and actions. */
  let {
    title,
    description,
    class: className,
    eyebrow,
    meta,
    actions,
  }: { title: string; description?: string; class?: ClassValue; eyebrow?: Snippet; meta?: Snippet; actions?: Snippet } = $props();
</script>

<header class={["flex flex-wrap items-end justify-between gap-x-6 gap-y-4", className]}>
  <div class="min-w-0">
    {#if eyebrow}<div class="mb-1">{@render eyebrow()}</div>{/if}
    <h1 class="text-2xl font-semibold tracking-tight text-balance text-zinc-950 dark:text-white">{title}</h1>
    {#if description}<p class="mt-1 max-w-[65ch] text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">{description}</p>{/if}
    {#if meta}<div class="mt-2">{@render meta()}</div>{/if}
  </div>
  {#if actions}<div class="flex shrink-0 items-center gap-2">{@render actions()}</div>{/if}
</header>

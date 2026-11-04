<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** Titled group of settings rows on one card (T3 style); `actions` sit right of the title. */
  let {
    title,
    description,
    class: className,
    actions,
    children,
  }: { title?: string; description?: string; class?: ClassValue; actions?: Snippet; children: Snippet } = $props();

  const id = $props.id();
</script>

<section class={className} aria-labelledby={title ? id : undefined}>
  {#if title || actions}
    <div class="mb-3 flex items-end justify-between gap-4 px-1">
      <div class="min-w-0">
        {#if title}<h2 {id} class="text-base/7 font-semibold text-zinc-950 dark:text-white">{title}</h2>{/if}
        {#if description}<p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
            {description}
          </p>{/if}
      </div>
      {#if actions}<div class="flex shrink-0 items-center gap-2">{@render actions()}</div>{/if}
    </div>
  {/if}
  <div
    class="divide-y divide-zinc-950/5 overflow-hidden rounded-2xl bg-white ring-1 ring-zinc-950/10 dark:divide-white/8 dark:bg-zinc-950 dark:ring-white/10"
  >
    {@render children()}
  </div>
</section>

<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** Title of a settings page below a section (a project, a worker): optional leading mark, description, actions. */
  let {
    title,
    description,
    class: className,
    leading,
    actions,
  }: {
    title: string;
    description?: string | undefined;
    class?: ClassValue;
    leading?: Snippet;
    actions?: Snippet;
  } = $props();
</script>

<div class={["flex flex-wrap items-start justify-between gap-4", className]}>
  <div class="min-w-0">
    <div class="flex min-w-0 items-center gap-3">
      {@render leading?.()}
      <h1 class="truncate text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white">{title}</h1>
    </div>
    {#if description}<p class="mt-1 text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        {description}
      </p>{/if}
  </div>
  {#if actions}<div class="flex shrink-0 items-center gap-2">{@render actions()}</div>{/if}
</div>

<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** A titled block of the instance detail (Status, Runtime, Environment, Models…), separated by a top rule. */
  let {
    title,
    description,
    class: className,
    actions,
    children,
  }: {
    title: string;
    description?: string | undefined;
    class?: ClassValue;
    actions?: Snippet;
    children: Snippet;
  } = $props();

  const id = $props.id();
</script>

<section
  aria-labelledby={id}
  class={[
    "grid gap-(--settings-field-gap,0.75rem) border-t border-zinc-950/5 pt-4 first:border-t-0 first:pt-0 dark:border-white/8",
    className,
  ]}
>
  <div class="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
    <div class="min-w-0">
      <h3 {id} class="text-base/7 font-semibold text-zinc-950 dark:text-white">{title}</h3>
      {#if description}<p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          {description}
        </p>{/if}
    </div>
    {#if actions}<div class="flex shrink-0 items-center gap-2">{@render actions()}</div>{/if}
  </div>
  {@render children()}
</section>

<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "./Icon.svelte";

  /**
   * One row of a settings card: title, description, and a control on the right. With `href` the whole
   * row is a link with a chevron (lists of projects, workers).
   */
  let {
    title,
    description,
    href,
    class: className,
    leading,
    control,
    children,
  }: {
    title: string;
    description?: string | undefined;
    href?: string | undefined;
    class?: ClassValue;
    leading?: Snippet;
    control?: Snippet;
    children?: Snippet;
  } = $props();
</script>

{#snippet body()}
  {#if leading}<div class="flex h-lh shrink-0 items-center text-base/6 sm:text-sm/6">{@render leading()}</div>{/if}
  <div class="min-w-0 flex-1">
    <p class="truncate text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">{title}</p>
    {#if description}<p class="text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">{description}</p>{/if}
    {@render children?.()}
  </div>
  {#if control}<div class="flex shrink-0 items-center gap-2">{@render control()}</div>{/if}
  {#if href}<Icon name="chevron-right" class="fill-zinc-400 dark:fill-zinc-600" />{/if}
{/snippet}

{#if href}
  <a
    {href}
    class={[
      "flex items-center gap-3 px-4 py-3.5 focus-ring hover:bg-zinc-950/2.5 focus-visible:-outline-offset-2 dark:hover:bg-white/2.5",
      className,
    ]}>{@render body()}</a
  >
{:else}
  <div class={["flex flex-col items-start gap-3 px-4 py-3.5 sm:flex-row sm:items-center", className]}>
    {@render body()}
  </div>
{/if}

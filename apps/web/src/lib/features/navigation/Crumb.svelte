<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { clipped } from "#lib/shared/ui/clipped.ts";

  /**
   * One breadcrumb step; links when `href` is set. A slash separates it from the previous one. The current
   * step keeps its room: ancestors give way first, down to their `mark` and the start of their name (their
   * name breaks anywhere, so it can get that small and fills its line, but shows one line). From `lg` up there is room for more:
   * an ancestor keeps its whole name up to 9rem (`--natural`, measured). A cut-off name shows in full in a
   * tooltip (hover, keyboard focus or a long press); assistive technology always reads all of it.
   */
  let {
    href,
    current = !href,
    mark,
    class: className,
    children,
  }: {
    href?: string | undefined;
    current?: boolean;
    mark?: Snippet;
    class?: ClassValue;
    children: Snippet;
  } = $props();

  let full = $state<string>();
  let natural = $state(0);
</script>

<li
  class={[
    "flex items-center gap-2 not-first:before:shrink-0 not-first:before:text-zinc-300 not-first:before:content-['/'] dark:not-first:before:text-zinc-700",
    // Overwhelmingly: the current step must not lose even the fraction of a pixel that would cut its name.
    current ? "min-w-0" : "shrink-100000",
    className,
  ]}
>
  {#snippet body()}
    {@render mark?.()}<span
      class={current
        ? "min-w-0 truncate"
        : "line-clamp-1 min-w-[1.25em] break-all lg:min-w-[max(1.25em,min(9rem,var(--natural)))]"}
      style:--natural="{natural}px"
      {@attach clipped((fit) => {
        full = fit.clipped;
        natural = fit.natural;
      })}>{@render children()}</span
    >
  {/snippet}
  {#if href}
    <a
      {href}
      class="flex min-w-0 items-center gap-2 rounded-sm focus-ring hover:text-zinc-950 dark:hover:text-white"
      aria-current={current ? "page" : undefined}
      {@attach tooltip(full, { placement: "bottom" })}>{@render body()}</a
    >
  {:else}
    <span
      class="flex min-w-0 items-center gap-2"
      aria-current={current ? "page" : undefined}
      {@attach tooltip(full, { placement: "bottom" })}>{@render body()}</span
    >
  {/if}
</li>

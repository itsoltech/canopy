<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue, HTMLButtonAttributes } from "svelte/elements";
  import Icon from "./Icon.svelte";
  import TouchTarget from "./TouchTarget.svelte";

  /**
   * Low-key button that opens a menu or picker (T3's composer pills): content, then a chevron. Spread
   * a popover trigger's props on it: `{#snippet trigger(props)}<PillButton {...props}>Ask first</PillButton>{/snippet}`.
   */
  type Props = Omit<HTMLButtonAttributes, "class" | "children"> & { class?: ClassValue; chevron?: boolean; children: Snippet };
  let { class: className, chevron = true, type = "button", children, ...rest }: Props = $props();
</script>

<button
  {type}
  class={[
    "relative flex min-w-0 items-center gap-1.5 rounded-lg py-1.5 pr-1.5 pl-2 text-sm/5 text-zinc-600 focus-ring hover:bg-zinc-950/5 hover:text-zinc-950 aria-expanded:bg-zinc-950/5 aria-expanded:text-zinc-950 sm:text-[0.8125rem]/5 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white dark:aria-expanded:bg-white/5 dark:aria-expanded:text-white",
    className,
  ]}
  {...rest}
>
  {@render children()}
  {#if chevron}<Icon name="chevron-down" class="size-3.5 fill-zinc-400 dark:fill-zinc-500" />{/if}
  <TouchTarget />
</button>

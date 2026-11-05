<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { paletteHeaderClass } from "#lib/features/commands/palette-style.ts";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";

  /** The search row of an Add project step: Back (or a search mark on the first step), the input, an action. */
  let {
    onback,
    onclose,
    children,
    action,
    class: className,
  }: {
    onback?: (() => void) | undefined;
    onclose: () => void;
    children: Snippet;
    action?: Snippet | undefined;
    class?: ClassValue;
  } = $props();
</script>

<div class={[paletteHeaderClass, className]}>
  {#if onback}
    <IconButton icon="arrow-left" label="Back" size="sm" onclick={onback} />
  {:else}
    <Icon name="magnifying-glass" class="fill-zinc-400 dark:fill-zinc-500" />
  {/if}
  {@render children()}
  {#if action}<div class="flex shrink-0 items-center">{@render action()}</div>{/if}
  <IconButton icon="x-mark" label="Close" size="sm" class="sm:hidden" onclick={onclose} />
</div>

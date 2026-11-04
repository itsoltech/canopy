<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";

  /**
   * Row of the context panel: icon (or `lead`, e.g. a brand mark), content, optional aside. A link with
   * `href`, a button with `onclick`.
   */
  let {
    icon,
    iconClass,
    href,
    onclick,
    current = false,
    wrap = false,
    class: className,
    children,
    aside,
    lead,
  }: {
    icon: IconName;
    iconClass?: ClassValue;
    href?: string | undefined;
    onclick?: (() => void) | undefined;
    current?: boolean;
    wrap?: boolean;
    class?: ClassValue;
    children: Snippet;
    aside?: Snippet;
    lead?: Snippet;
  } = $props();

  const interactive = $derived(Boolean(href || onclick));

  const classes = $derived([
    "flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-left text-base/6 text-zinc-700 sm:py-1.5 sm:text-sm/6 dark:text-zinc-300",
    interactive && "hover:bg-zinc-950/4 hover:text-zinc-950 focus-ring dark:hover:bg-white/5 dark:hover:text-white",
    current && "bg-zinc-950/5 text-zinc-950 dark:bg-white/8 dark:text-white",
    className,
  ]);
</script>

{#snippet content()}
  {#if lead}{@render lead()}{:else}<Icon name={icon} class={iconClass ?? "fill-zinc-400 dark:fill-zinc-500"} />{/if}
  <span class={["min-w-0 flex-1", wrap ? "break-words whitespace-normal" : "truncate"]}>{@render children()}</span>
  {@render aside?.()}
{/snippet}

{#if href}
  <a {href} class={classes} aria-current={current ? "page" : undefined}>{@render content()}</a>
{:else if onclick}
  <button type="button" class={classes} {onclick}>{@render content()}</button>
{:else}
  <div class={classes}>{@render content()}</div>
{/if}

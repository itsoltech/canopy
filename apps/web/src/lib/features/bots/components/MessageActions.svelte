<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import Menu, { type MenuItem } from "./Menu.svelte";
  import Tooltip from "./Tooltip.svelte";

  /**
   * React, reply and more on a message. Hidden until the message is hovered or something in it has
   * focus (the parent is a `group/message`); always reachable with Tab. Missing handlers hide their
   * button, an empty `more` hides the menu.
   */
  let {
    label,
    onreact,
    onreply,
    more = [],
    class: className,
  }: { label: string; onreact?: (() => void) | undefined; onreply?: (() => void) | undefined; more?: readonly MenuItem[]; class?: ClassValue } = $props();

  const button =
    "relative grid size-8 place-items-center rounded-md text-zinc-500 hover:bg-zinc-950/5 hover:text-zinc-950 focus-ring sm:size-7 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-white";
</script>

{#snippet action(icon: IconName, text: string, onclick: () => void)}
  <Tooltip {text} side="top">
    {#snippet children(tip)}
      <button type="button" class={button} aria-label={text} aria-describedby={tip} {onclick}>
        <Icon name={icon} />
        <TouchTarget />
      </button>
    {/snippet}
  </Tooltip>
{/snippet}

<div
  role="toolbar"
  aria-label={label}
  class={[
    "flex shrink-0 items-center rounded-lg bg-white p-0.5 opacity-0 shadow-sm ring-1 ring-zinc-950/10 group-hover/message:opacity-100 group-has-focus-visible/message:opacity-100 has-aria-expanded:opacity-100 pointer-coarse:hidden dark:bg-zinc-900 dark:shadow-none dark:ring-white/10",
    className,
  ]}
>
  {#if onreact}{@render action("face-smile", "React", onreact)}{/if}
  {#if onreply}{@render action("arrow-uturn-left", "Reply", onreply)}{/if}
  {#if more.length > 0}
    <Menu items={more} label="More actions">
      {#snippet trigger(props)}
        <button type="button" class={button} aria-label="More" {...props}>
          <Icon name="ellipsis-horizontal" />
          <TouchTarget />
        </button>
      {/snippet}
    </Menu>
  {/if}
</div>

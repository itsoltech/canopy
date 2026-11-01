<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import type { BotAction } from "../actions.ts";
  import ActionItems from "./ActionItems.svelte";

  /**
   * React, reply and more on a message. Hidden until the message is hovered or something in it has
   * focus (the parent is a `group/message`); always reachable with Tab. Missing handlers hide their
   * button, an empty `more` hides the menu. On touch screens the bubble's long press replaces it.
   */
  let {
    label,
    onreact,
    onreply,
    more = [],
    class: className,
  }: { label: string; onreact?: (() => void) | undefined; onreply?: (() => void) | undefined; more?: readonly BotAction[]; class?: ClassValue } = $props();
</script>

<div
  role="toolbar"
  aria-label={label}
  class={[
    "flex shrink-0 items-center rounded-lg bg-white p-0.5 opacity-0 shadow-sm ring-1 ring-zinc-950/10 group-hover/message:opacity-100 group-has-focus-visible/message:opacity-100 has-aria-expanded:opacity-100 pointer-coarse:hidden dark:bg-zinc-900 dark:shadow-none dark:ring-white/10",
    className,
  ]}
>
  {#if onreact}<IconButton icon="face-smile" label="React" size="sm" onclick={onreact} />{/if}
  {#if onreply}<IconButton icon="arrow-uturn-left" label="Reply" size="sm" onclick={onreply} />{/if}
  {#if more.length > 0}
    <DropdownMenu label="More actions" placement="bottom-end">
      {#snippet trigger(props)}
        <IconButton icon="ellipsis-horizontal" label="More" size="sm" {...props} />
      {/snippet}
      <ActionItems actions={more} />
    </DropdownMenu>
  {/if}
</div>

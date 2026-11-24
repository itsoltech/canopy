<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import type { BotAction } from "../actions.ts";
  import MessageReactionPicker from "./MessageReactionPicker.svelte";
  import ActionItems from "./ActionItems.svelte";

  /**
   * Quiet actions beside a message: react, reply, copy and more. They fade in while the message is
   * hovered or something in it has focus (the parent is a `group/message`) and are always reachable with
   * Tab. Missing handlers hide their button, an empty `more` hides the menu. On touch screens React stays visible and a long press opens the other actions.
   */
  let {
    label,
    onreact,
    reactions,
    reactionTriggerId,
    pickerOpen = $bindable(false),
    onreply,
    text,
    more = [],
    class: className,
  }: {
    label: string;
    onreact?: ((emoji: string, active: boolean) => void) | undefined;
    reactions?: readonly string[] | undefined;
    reactionTriggerId: string;
    pickerOpen?: boolean;
    onreply?: (() => void) | undefined;
    text?: string | undefined;
    more?: readonly BotAction[];
    class?: ClassValue;
  } = $props();
</script>

<div
  role="toolbar"
  aria-label={label}
  class={[
    "flex shrink-0 items-center opacity-0 transition-opacity duration-(--duration-quick) ease-out group-hover/message:opacity-100 group-hover/message:delay-(--duration-micro) group-has-[:focus-visible]/message:opacity-100 has-aria-expanded:opacity-100",
    reactions ? "pointer-coarse:opacity-100" : "pointer-coarse:hidden",
    className,
  ]}
>
  {#if onreact && reactions}
    <MessageReactionPicker {reactions} {onreact} triggerId={reactionTriggerId} bind:open={pickerOpen} />
  {:else if reactions}
    <!-- Keep the bubble's width while the cached conversation connects. -->
    <IconButton icon="face-smile" label="React to message" size="sm" disabled class="invisible" />
  {/if}
  <div class="contents pointer-coarse:hidden">
    {#if onreply}<IconButton icon="arrow-uturn-left" label="Reply" size="sm" onclick={onreply} />{/if}
    <!-- Reserve Copy's slot before the first streamed character arrives. -->
    {#if text !== undefined}<CopyButton {text} label="Copy text" class={text ? undefined : "invisible"} />{/if}
    {#if more.length > 0}
      <DropdownMenu label="More actions" placement="bottom-end">
        {#snippet trigger(props)}
          <IconButton icon="ellipsis-horizontal" label="More" size="sm" {...props} />
        {/snippet}
        <ActionItems actions={more} />
      </DropdownMenu>
    {/if}
  </div>
</div>

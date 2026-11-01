<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import { anchorOnly } from "#lib/shared/ui/Popover.svelte";
  import type { BotAction } from "../actions.ts";
  import { fullDateLabel, timeLabel } from "../chat-timeline.ts";
  import { contextMenu } from "../context-menu.ts";
  import type { ChatMessageView, ParticipantView } from "../model.ts";
  import LinkChip from "./LinkChip.svelte";
  import ActionItems from "./ActionItems.svelte";
  import MessageActions from "./MessageActions.svelte";
  import MessageRow from "./MessageRow.svelte";

  /**
   * One message in a run. Bots write markdown (safe renderer); your messages are plain text on the
   * accent colour, on the right. The corners facing the rest of the run are tighter, the avatar sits
   * beside the last bubble and the sender's name above the first (groups and watched chats). Actions
   * appear on hover or focus; on touch screens a long press opens them as a menu.
   */
  let {
    message,
    sender,
    side = "start",
    mine = false,
    first = true,
    last = true,
    showName = false,
    replyToName,
    onreact,
    onreply,
    more = [],
    class: className,
  }: {
    message: ChatMessageView;
    sender: ParticipantView | undefined;
    side?: "start" | "end";
    mine?: boolean;
    first?: boolean;
    last?: boolean;
    showName?: boolean;
    /** Name of the author of the quoted message. */
    replyToName?: string | undefined;
    onreact?: ((message: ChatMessageView) => void) | undefined;
    onreply?: ((message: ChatMessageView) => void) | undefined;
    more?: readonly BotAction[];
    class?: ClassValue;
  } = $props();

  let touchMenuOpen = $state(false);
  const react = $derived(onreact ? () => onreact(message) : undefined);
  const reply = $derived(onreply ? () => onreply(message) : undefined);
  const touchItems = $derived<BotAction[]>([
    ...(react ? [{ label: "React", icon: "face-smile" as const, onselect: react }] : []),
    ...(reply ? [{ label: "Reply", icon: "arrow-uturn-left" as const, onselect: reply }] : []),
    ...more,
  ]);
  const end = $derived(side === "end");
  const corners = $derived([
    "rounded-2xl",
    !first && (end ? "rounded-tr-md" : "rounded-tl-md"),
    !last && (end ? "rounded-br-md" : "rounded-bl-md"),
  ]);
</script>

<MessageRow {sender} {side} {mine} showAvatar={last} {showName} class={["group/message", className]}>
  {#if message.replyTo}
    <p class={["flex max-w-[min(85%,32rem)] items-center gap-1.5 px-3 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400", end && "flex-row-reverse"]}>
      <Icon name="arrow-uturn-left" class="size-3.5 shrink-0 fill-zinc-400 dark:fill-zinc-500" />
      <span class="min-w-0 truncate"><span class="font-medium">{replyToName ?? "Reply"}</span>: {message.replyTo.excerpt}</span>
    </p>
  {/if}
  <div class={["flex max-w-full items-center gap-2", end && "flex-row-reverse"]}>
    <DropdownMenu label="Message actions" bind:open={touchMenuOpen} placement={end ? "bottom-end" : "bottom-start"}>
      {#snippet trigger(props)}
        <div
          {...anchorOnly(props)}
          class={[
            "max-w-[min(100%,36rem)] min-w-0 px-3.5 py-2 wrap-anywhere select-text",
            corners,
            mine ? "bg-brand-600 text-base/6 whitespace-pre-wrap text-white sm:text-sm/6" : "bg-zinc-100 dark:bg-white/8",
            message.delivery === "sending" && "opacity-70",
          ]}
          title={fullDateLabel(message.at)}
          {@attach contextMenu(() => {
            if (matchMedia("(pointer: coarse)").matches && touchItems.length > 0) touchMenuOpen = true;
          })}
        >
          <span class="sr-only">{mine ? "You" : (sender?.name ?? "Unknown")}, {timeLabel(message.at)}: </span>{#if mine}{message.text}{:else}<Markdown text={message.text} />{/if}
        </div>
      {/snippet}
      <ActionItems actions={touchItems} />
    </DropdownMenu>
    {#if react || reply || more.length > 0}
      <MessageActions label="Actions for this message" onreact={react} onreply={reply} {more} />
    {/if}
  </div>
  {#if message.links && message.links.length > 0}
    <ul role="list" class={["flex max-w-full flex-wrap gap-1.5", end && "justify-end"]}>
      {#each message.links as link (link.url)}
        <li class="max-w-full min-w-0"><LinkChip {link} /></li>
      {/each}
    </ul>
  {/if}
  {#if message.delivery}
    <p class={["flex items-center gap-1 px-3 text-sm/5 sm:text-xs/5", message.delivery === "failed" ? "text-rose-600 dark:text-rose-400" : "text-zinc-500 dark:text-zinc-400"]}>
      {#if message.delivery === "failed"}<Icon name="exclamation-circle" class="size-3.5" />Not sent{:else}Sending…{/if}
    </p>
  {/if}
</MessageRow>

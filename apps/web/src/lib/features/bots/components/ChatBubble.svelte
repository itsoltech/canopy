<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { MentionKind } from "@canopy/contracts";
  import ConnectorChip from "#lib/features/connectors/ConnectorChip.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import { anchorOnly } from "#lib/shared/ui/Popover.svelte";
  import type { BotAction } from "../actions.ts";
  import { fullDateLabel, timeLabel } from "../chat-timeline.ts";
  import { contextMenu } from "../context-menu.ts";
  import { mentionRanges, structuredMentionRanges } from "../mentions.ts";
  import type { ChatMessageView, ParticipantView } from "@canopy/domain/bot-chat";
  import ActionItems from "./ActionItems.svelte";
  import BotChip from "./BotChip.svelte";
  import LinkChip from "./LinkChip.svelte";
  import MessageActions from "./MessageActions.svelte";
  import MessageRow from "./MessageRow.svelte";
  import MessageQuotes from "#lib/features/quotes/MessageQuotes.svelte";

  /**
   * One message in a run. Bots write markdown (safe renderer) on soft grey, other bots named in it become
   * chips in their colour; your messages are plain text on the dark neutral (light in dark mode), on the
   * right. The corners facing the rest of the run are tighter, the avatar sits beside the last bubble and
   * the sender's name above the first (groups and watched chats). Actions (reply, copy, …) appear beside
   * the bubble on hover or focus; on touch screens a long press opens them as a menu.
   */
  let {
    message,
    sender,
    side = "start",
    mine = false,
    first = true,
    last = true,
    showName = false,
    gutter = true,
    replyToName,
    bots = [],
    conversationId,
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
    /** The avatar column (group chats); a 1:1 chat has none. */
    gutter?: boolean;
    showName?: boolean;
    /** Name of the author of the quoted message. */
    replyToName?: string | undefined;
    /** Bots whose names become chips in the text. */
    bots?: readonly ParticipantView[];
    conversationId?: string;
    onreact?: ((message: ChatMessageView) => void) | undefined;
    onreply?: ((message: ChatMessageView) => void) | undefined;
    more?: readonly BotAction[];
    class?: ClassValue;
  } = $props();

  let touchMenuOpen = $state(false);
  const react = $derived(onreact ? () => onreact(message) : undefined);
  const reply = $derived(onreply ? () => onreply(message) : undefined);
  const copy = () => void navigator.clipboard?.writeText(message.text).catch(() => undefined);

  const touchItems = $derived<BotAction[]>([
    ...(react ? [{ label: "React", icon: "face-smile" as const, onselect: react }] : []),
    ...(reply ? [{ label: "Reply", icon: "arrow-uturn-left" as const, onselect: reply }] : []),
    { label: "Copy text", icon: "copy" as const, onselect: copy },
    ...more,
  ]);

  const end = $derived(side === "end");

  const mentions = $derived(
    (mine
      ? [
          ...structuredMentionRanges(message.text, message.mentions ?? [], bots).map((r) => ({
            ...r,
            connector: undefined,
          })),
          ...(message.mentions ?? [])
            .filter((m) => m.kind === MentionKind.CONNECTOR && m.start < m.end && m.end <= message.text.length)
            .map((m) => ({ start: m.start, end: m.end, connector: m, bot: undefined })),
        ]
      : mentionRanges(
          message.text,
          bots.filter((b) => b.id !== message.senderId),
        ).map((r) => ({ ...r, connector: undefined }))
    ).sort((a, b) => a.start - b.start),
  );

  // Concentric with the run: the side facing a neighbour gets the small radius.
  const corners = $derived([
    "rounded-[1.25rem]",
    !first && (end ? "rounded-tr-md" : "rounded-tl-md"),
    !last && (end ? "rounded-br-md" : "rounded-bl-md"),
  ]);
</script>

{#snippet mention(index: number)}
  {@const found = mentions[index]}
  {#if found?.connector}<ConnectorChip mention={found.connector} />{:else if found?.bot}<BotChip bot={found.bot} />{/if}
{/snippet}

<MessageRow {sender} {side} {mine} showAvatar={last} {showName} {gutter} class={["group/message", className]}>
  {#if message.replyTo}
    <p
      class={[
        "flex max-w-[min(85%,32rem)] items-center gap-1.5 px-3 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400",
        end && "flex-row-reverse",
      ]}
    >
      <Icon name="arrow-uturn-left" class="size-3.5 shrink-0 fill-zinc-400 dark:fill-zinc-500" />
      <span class="min-w-0 truncate"
        ><span class="font-medium">{replyToName ?? "Reply"}</span>: {message.replyTo.excerpt}</span
      >
    </p>
  {/if}
  <div class={["flex max-w-full items-center gap-1", end && "flex-row-reverse"]}>
    <DropdownMenu label="Message actions" bind:open={touchMenuOpen} placement={end ? "bottom-end" : "bottom-start"}>
      {#snippet trigger(props)}
        <div
          {...anchorOnly(props)}
          class={[
            "max-w-[min(100%,36rem)] min-w-0 px-4 py-2 wrap-anywhere select-text",
            corners,
            mine
              ? "bg-zinc-900 text-base/6 whitespace-pre-wrap text-white [--bot-chip-dark-target:black] [--bot-chip-light-target:white] sm:text-sm/6 dark:bg-zinc-100 dark:text-zinc-950"
              : "bg-zinc-100 text-zinc-900 dark:bg-zinc-800/80 dark:text-zinc-100 [&_pre]:my-1 [&>div]:gap-2 [&>div]:text-base/6 sm:[&>div]:text-sm/6",
            message.delivery === "sending" && "opacity-60",
          ]}
          title={fullDateLabel(message.at)}
          data-quote-item={message.id}
          data-quote-thread={conversationId}
          {@attach contextMenu(() => {
            if (matchMedia("(pointer: coarse)").matches) touchMenuOpen = true;
          })}
        >
          <span class="sr-only" data-quote-skip
            >{mine ? "You" : (sender?.name ?? "Unknown")}, {timeLabel(message.at)}:
          </span>{#if message.quotes?.length}<MessageQuotes
              quotes={message.quotes}
              inverted={mine}
              class="pb-2"
            />{/if}{#if mine}{#each mentions as found, index (found.start)}{message.text.slice(
                index === 0 ? 0 : mentions[index - 1]!.end,
                found.start,
              )}{@render mention(index)}{/each}{message.text.slice(mentions.at(-1)?.end ?? 0)}{:else}<div
              data-quote-kind="agent_message"
            >
              <Markdown
                text={message.text}
                elements={mentions.length > 0 ? { ranges: mentions, render: mention } : undefined}
              />
            </div>{/if}
        </div>
      {/snippet}
      <ActionItems actions={touchItems} />
    </DropdownMenu>
    <MessageActions label="Actions for this message" onreact={react} onreply={reply} text={message.text} {more} />
  </div>
  {#if message.links && message.links.length > 0}
    <ul role="list" class={["flex max-w-full flex-wrap gap-1.5", end && "justify-end"]}>
      {#each message.links as link (link.url)}
        <li class="max-w-full min-w-0"><LinkChip {link} /></li>
      {/each}
    </ul>
  {/if}
  {#if message.delivery}
    <p
      class={[
        "flex items-center gap-1 px-3 text-sm/5 sm:text-xs/5",
        message.delivery === "failed" ? "text-rose-600 dark:text-rose-400" : "text-zinc-500 dark:text-zinc-400",
      ]}
    >
      {#if message.delivery === "failed"}<Icon name="exclamation-circle" tone="inherit" class="size-3.5" />Not sent{:else}Sending…{/if}
    </p>
  {/if}
</MessageRow>

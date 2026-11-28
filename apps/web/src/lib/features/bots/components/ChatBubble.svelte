<script lang="ts">
  import MessageAttachments from "#lib/features/attachments/MessageAttachments.svelte";
  import type { ClassValue } from "svelte/elements";
  import { MentionKind } from "@canopy/contracts";
  import ConnectorChip from "#lib/features/connectors/ConnectorChip.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import { anchorOnly } from "#lib/shared/ui/Popover.svelte";
  import type { BotAction } from "../actions.ts";
  import { formatLocalDateTime } from "#lib/shared/format.ts";
  import { fullDateLabel } from "../chat-timeline.ts";
  import { contextMenu } from "../context-menu.ts";
  import { mentionRanges, structuredMentionRanges } from "../mentions.ts";
  import { retainStreamWidth } from "../stream-width.ts";
  import type { ChatMessageView, ParticipantView } from "@canopy/domain/bot-chat";
  import ActionItems from "./ActionItems.svelte";
  import BotChip from "./BotChip.svelte";
  import LinkChip from "./LinkChip.svelte";
  import MessageActions from "./MessageActions.svelte";
  import { botReactionOptions } from "@canopy/domain/bot-reactions";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import MessageRow from "./MessageRow.svelte";
  import MessageQuotes from "#lib/features/quotes/MessageQuotes.svelte";
  import CitationChip from "#lib/features/quotes/CitationChip.svelte";

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
    reactions,
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
    /** Selected reactions when this message supports the owner's reaction action. */
    reactions?: readonly string[] | undefined;
    onreact?: ((messageId: string, emoji: string, active: boolean) => void) | undefined;
    onreply?: ((message: ChatMessageView) => void) | undefined;
    more?: readonly BotAction[];
    class?: ClassValue;
  } = $props();

  let touchMenuOpen = $state(false);
  const reactionTriggerId = $props.id();
  let pickerOpen = $state(false);
  const activeReactions = $derived(botReactionOptions.filter(({ emoji }) => message.reactions?.includes(emoji)));

  const reactionPill = $derived([
    "inline-flex h-6 min-w-8 items-center justify-center rounded-full bg-zinc-100 px-2 text-sm dark:bg-zinc-800",
    reactions && "pointer-coarse:min-h-11 pointer-coarse:min-w-11",
  ]);

  const react = $derived(
    reactions && onreact ? (emoji: string, active: boolean) => onreact(message.id, emoji, active) : undefined,
  );

  const reply = $derived(onreply ? () => onreply(message) : undefined);
  const copy = () => void navigator.clipboard?.writeText(message.text).catch(() => undefined);

  const touchItems = $derived<BotAction[]>([
    ...(react ? [{ label: "React", icon: "face-smile" as const, onselect: () => (pickerOpen = true) }] : []),
    ...(reply ? [{ label: "Reply", icon: "arrow-uturn-left" as const, onselect: reply }] : []),
    { label: "Copy text", icon: "copy" as const, onselect: copy },
    ...more,
  ]);

  const end = $derived(side === "end");

  // botEntries gives the transient reply a separate id; settlement mounts a fresh, content-sized bubble.
  const streaming = $derived(message.id.startsWith("stream:"));

  const sentAt = $derived(message.delivery ? undefined : message.at);

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
    )
      .map((m) => ({ ...m, quote: undefined }))
      .sort((a, b) => a.start - b.start),
  );

  const inline = $derived(
    [
      ...mentions,
      ...(message.quotes ?? []).flatMap((quote) =>
        quote.start !== undefined && quote.end !== undefined
          ? [{ start: quote.start, end: quote.end, quote, connector: undefined, bot: undefined }]
          : [],
      ),
    ].sort((a, b) => a.start - b.start),
  );

  const looseQuotes = $derived(message.quotes?.filter((q) => q.start === undefined) ?? []);

  // Concentric with the run: the side facing a neighbour gets the small radius.
  const corners = $derived([
    "rounded-[1.25rem]",
    !first && (end ? "rounded-tr-md" : "rounded-tl-md"),
    !last && (end ? "rounded-br-md" : "rounded-bl-md"),
  ]);
</script>

{#snippet mention(index: number)}
  {@const found = inline[index]}
  {#if found?.quote}<CitationChip quote={found.quote} inverted={mine} />{:else if found?.connector}<ConnectorChip
      mention={found.connector}
    />{:else if found?.bot}<BotChip bot={found.bot} />{/if}
{/snippet}

<MessageRow {sender} {side} {mine} showAvatar={last} {showName} {gutter} class={["group/message", className]}>
  {#if message.replyTo}
    <p
      class={[
        "flex items-center gap-1.5 px-3 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400",
        mine ? "max-w-[min(85%,var(--chat-user-bubble-width))]" : "max-w-(--chat-bubble-width)",
        end && "flex-row-reverse",
      ]}
    >
      <Icon name="arrow-uturn-left" class="size-3.5 shrink-0 fill-zinc-400 dark:fill-zinc-500" />
      <span class="min-w-0 truncate select-text"
        ><span class="font-medium">{replyToName ?? "Reply"}</span>: {message.replyTo.excerpt}</span
      >
    </p>
  {/if}
  <div class={["flex max-w-full min-w-0 items-center gap-1", !mine && "w-full", end && "flex-row-reverse"]}>
    <DropdownMenu label="Message actions" bind:open={touchMenuOpen} placement={end ? "bottom-end" : "bottom-start"}>
      {#snippet trigger(props)}
        <div
          {...anchorOnly(props)}
          class={[
            "min-w-[var(--chat-stream-width,0px)] px-[calc(var(--theme-space)*4)] py-[calc(var(--theme-space)*2)] wrap-anywhere select-text",
            mine ? "max-w-[min(100%,var(--chat-user-bubble-width))]" : "w-fit max-w-(--chat-bubble-width)",
            corners,
            mine
              ? "bg-zinc-900 text-base/6 whitespace-pre-wrap text-white [--bot-chip-dark-target:black] [--bot-chip-light-target:white] sm:text-sm/6 dark:bg-zinc-100 dark:text-zinc-950"
              : "bg-zinc-100 text-zinc-900 dark:bg-zinc-800/80 dark:text-zinc-100 [&_pre]:my-1 [&>div]:gap-2 [&>div]:text-base/6 sm:[&>div]:text-sm/6",
            message.delivery === "sending" && "opacity-60",
          ]}
          data-quote-item={message.id}
          data-quote-thread={conversationId}
          data-quote-author={sender?.name || "Agent"}
          data-quote-time={sentAt ? fullDateLabel(sentAt) : undefined}
          {@attach streaming ? retainStreamWidth : undefined}
          {@attach contextMenu(() => {
            if (matchMedia("(pointer: coarse)").matches) touchMenuOpen = true;
          })}
        >
          <span class="sr-only" data-quote-skip>{mine ? "You" : (sender?.name ?? "Unknown")}:</span
          >{#if looseQuotes.length}<MessageQuotes
              quotes={looseQuotes}
              inverted={mine}
              class="pb-2"
            />{/if}{#if mine}{#each inline as found, index (found.start)}{message.text.slice(
                index === 0 ? 0 : inline[index - 1]!.end,
                found.start,
              )}{@render mention(index)}{/each}{message.text.slice(inline.at(-1)?.end ?? 0)}{:else}<div
              data-quote-kind="agent_message"
            >
              <Markdown
                text={message.text}
                class="min-w-0 [&_blockquote]:max-w-(--chat-prose-width) [&_ol]:max-w-(--chat-prose-width) [&_p]:max-w-(--chat-prose-width) [&_ul]:max-w-(--chat-prose-width)"
                elements={inline.length > 0 ? { ranges: inline, render: mention } : undefined}
              />
            </div>{/if}
        </div>
      {/snippet}
      <ActionItems actions={touchItems} />
    </DropdownMenu>
    <MessageActions
      label="Actions for this message"
      {reactions}
      onreact={react}
      {reactionTriggerId}
      bind:pickerOpen
      onreply={reply}
      text={message.text}
      {more}
    />
  </div>
  {#if message.links && message.links.length > 0}
    <ul role="list" class={["flex max-w-full flex-wrap gap-1.5", end && "justify-end"]}>
      {#each message.links as link (link.url)}
        <li class="max-w-full min-w-0"><LinkChip {link} /></li>
      {/each}
    </ul>
  {/if}
  {#if message.attachments?.length}<MessageAttachments
      attachments={message.attachments}
      align={end ? "end" : "start"}
      class="w-full"
    />{/if}
  {#if activeReactions.length}
    <ul
      role="list"
      aria-label={mine ? "Bot reactions" : "Your reactions"}
      class={["flex max-w-full flex-wrap items-center gap-1", end && "justify-end"]}
    >
      {#each activeReactions as { emoji, label } (emoji)}
        <li>
          {#if react}
            <button
              type="button"
              aria-label={`Remove reaction: ${label}`}
              class={[reactionPill, "font-emoji focus-ring hover:bg-zinc-200 dark:hover:bg-zinc-700"]}
              {@attach tooltip(`Remove reaction: ${label}`)}
              onclick={() => {
                document.getElementById(reactionTriggerId)?.focus({ preventScroll: true });
                react?.(emoji, false);
              }}>{emoji}</button
            >
          {:else}
            <span class={reactionPill} title={label}>
              <span class="font-emoji" aria-hidden="true">{emoji}</span><span class="sr-only">{label}</span>
            </span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if sentAt}
    <time
      datetime={sentAt.toISOString()}
      data-quote-skip
      class={[
        "max-w-full px-3 text-sm/5 wrap-anywhere text-zinc-500 sm:text-xs/5 dark:text-zinc-400",
        end && "text-right",
      ]}
    >
      {formatLocalDateTime(sentAt)}
    </time>
  {/if}
  {#if message.delivery}
    <p
      role="status"
      class={message.delivery === "failed"
        ? "flex items-center gap-1 px-3 text-sm/5 text-rose-600 sm:text-xs/5 dark:text-rose-400"
        : "sr-only"}
    >
      {#if message.delivery === "failed"}<Icon name="exclamation-circle" tone="inherit" class="size-3.5" />Not sent{:else}Sending…{/if}
    </p>
  {/if}
</MessageRow>

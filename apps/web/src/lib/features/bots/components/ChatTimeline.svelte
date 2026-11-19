<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import FeedFold from "#lib/shared/ui/FeedFold.svelte";
  import { ChatEventGroups, type EventGroup } from "../event-groups.ts";
  import VirtualFeed from "#lib/shared/ui/virtual/VirtualFeed.svelte";
  import type { FeedViewport } from "#lib/shared/ui/virtual/viewport.ts";
  import type { FeedScrollMemory } from "#lib/shared/ui/virtual/feed-scroll-memory.svelte.ts";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { layoutChat, type ChatRow, type ExchangeSegment } from "../chat-timeline.ts";
  import type { ChatHistory } from "../chat-history.ts";
  import type {
    BotStatusView,
    ChatEntry,
    ChatMessageView,
    ConversationView,
    ParticipantView,
  } from "@canopy/domain/bot-chat";
  import ApprovalCard, { type ApprovalAnswer, type ApprovalPolicy } from "./ApprovalCard.svelte";
  import BotStatusRow from "./BotStatusRow.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import ChatBubble from "./ChatBubble.svelte";
  import ChatDateLine from "./ChatDateLine.svelte";
  import ChatErrorLine from "./ChatErrorLine.svelte";
  import ChatEventLine from "./ChatEventLine.svelte";
  import ExchangeLine from "./ExchangeLine.svelte";
  import MessageRow from "./MessageRow.svelte";
  import QuestionCard from "./QuestionCard.svelte";
  import UnreadDivider from "./UnreadDivider.svelte";

  /**
   * The entries of a conversation, laid out by `layoutChat`: time separators, the "New" divider, runs of
   * bubbles, bot ⇄ bot markers, cards and failures, then what the bot is doing now (`status`) under its last
   * message. The shared feed renders around the viewport and anchors it when older messages arrive.
   */
  let {
    conversation,
    entries,
    me,
    directory = [],
    firstUnreadId,
    status,
    answering = {},
    retrying = false,
    policy,
    exchangeHref,
    onanswer,
    onapprove,
    onpolicy,
    onretry,
    onchangemodel,
    onchangeworker,
    onreact,
    onreply,
    history,
    loading,
    syncing,
    top,
    placeholder,
    footer,
  }: {
    conversation: ConversationView;
    entries: readonly ChatEntry[];
    me: ParticipantView;
    /** Other bots you have: names and avatars in markers, mentions in messages. */
    directory?: readonly ParticipantView[];
    firstUnreadId?: string | undefined;
    /** What the bot is doing ("Typing…", "Checking Notion"); `waiting` when a card needs you. */
    status?: BotStatusView | undefined;
    /** Question or approval id → answer being sent. */
    answering?: Readonly<Record<string, string>>;
    retrying?: boolean;
    policy?: ApprovalPolicy | undefined;
    exchangeHref?: ((segment: ExchangeSegment) => string) | undefined;
    onanswer?: ((questionId: string, optionId: string) => void) | undefined;
    onapprove?: ((approvalId: string, answer: ApprovalAnswer) => void) | undefined;
    onpolicy?: ((policy: ApprovalPolicy) => void) | undefined;
    onretry?: (() => void) | undefined;
    onchangemodel?: (() => void) | undefined;
    onchangeworker?: (() => void) | undefined;
    onreact?: ((message: ChatMessageView) => void) | undefined;
    onreply?: ((message: ChatMessageView) => void) | undefined;
    history?: ChatHistory | undefined;
    loading: boolean;
    syncing: boolean;
    top?: Snippet | undefined;
    placeholder: Snippet;
    footer: Snippet;
  } = $props();

  const watching = $derived(conversation.kind === "watch");

  const participants = $derived(
    new Map<string, ParticipantView>([
      [me.id, me],
      ...directory.map((b) => [b.id, b] as const),
      ...conversation.bots.map((b) => [b.id, b] as const),
    ]),
  );

  const bots = $derived([...participants.values()].filter((p) => p.kind === "bot"));

  type TimelineRow = ChatRow | EventGroup | { id: "status"; kind: "status"; status: BotStatusView };

  const eventGroups = new ChatEventGroups();
  const openGroups = new SvelteSet<string>();

  const grouped = $derived(
    eventGroups.layout(
      layoutChat({
        entries,
        participants,
        me: me.id,
        kind: conversation.kind,
        firstUnreadId,
      }),
    ),
  );

  const rows = $derived.by((): TimelineRow[] => {
    if (loading) return [];

    const list: TimelineRow[] = [];

    for (const row of grouped) {
      list.push(row);

      if (row.kind === "event-group" && openGroups.has(row.id)) {
        for (const event of row.events) list.push(event);
      }
    }

    if (status) list.push({ id: "status", kind: "status", status });

    return list;
  });

  const estimates = new Map<string, number>([
    ["date", 48],
    ["message", 60],
    ["question", 200],
    ["approval", 150],
  ]);

  const estimate = (kind: string) => estimates.get(kind) ?? 52;
  const rowKey = (row: TimelineRow) => row.id;
  const group = (row: TimelineRow) => row.kind;
  const nameOf = (id: string) => participants.get(id)?.name;

  let feed: ReturnType<typeof VirtualFeed<TimelineRow>> | undefined;
  let atEnd = $state(true);
  let approachingHistory = $state(false);
  let historyViewport = $state.raw<{ start: number; before: bigint }>();
  const firstMessageId = $derived(history?.snapshot?.messages[0]?.id);

  function toggleEvents(id: string) {
    feed?.keep(id);

    if (openGroups.has(id)) openGroups.delete(id);
    else openGroups.add(id);
  }

  const historyRow = $derived(
    Math.max(
      0,
      rows.findIndex(
        (row) =>
          row.id === firstMessageId ||
          row.id === `exchanges:${firstMessageId}` ||
          (row.kind === "event-group" && row.events.some((event) => event.id === firstMessageId)),
      ),
    ),
  );

  // Approval cards can be older than the first paged message. Fetch before the reader crosses that boundary.
  const rememberViewport = (viewport: FeedViewport) => {
    const snapshot = history?.snapshot;

    if (snapshot?.historyHasMore) historyViewport = { start: viewport.start, before: snapshot.historyBeforeSeq };
  };

  $effect(() => {
    const current = history;

    if (loading || syncing || !current || current.loadingOlder || current.historyError) return;
    const snapshot = current.snapshot;

    if (!snapshot?.historyHasMore || (!atEnd && !approachingHistory)) return;

    if (historyViewport?.before !== snapshot.historyBeforeSeq || historyViewport.start > historyRow + 6) return;
    const { start } = historyViewport;

    untrack(() => {
      // A large keyboard scroll may reach unmounted content in one step. Hold its first measured row
      // before the response can add another page, and wait for fresh reader movement after a prepend.
      const anchor = rows[start]?.kind === "date" ? rows[start + 1] : rows[start];

      if (!atEnd && anchor) feed?.keep(anchor.id);
      approachingHistory = false;
      void current.loadOlder();
    });
  });

  const scrollMemory = untrack((): FeedScrollMemory | undefined =>
    firstUnreadId ? { initial: { mode: "anchor", key: `unread:${firstUnreadId}`, offset: 0 }, save() {} } : undefined,
  );

  export const reveal = (id: string) => feed?.reveal(id) ?? Promise.resolve(false);
  export const followLatest = () => feed?.jumpToLatest();

  const approvalAnswering = (value: string | undefined) =>
    value === "approve" || value === "discard" || value === "edit" ? value : undefined;
</script>

<VirtualFeed
  bind:this={feed}
  bind:atEnd
  {rows}
  key={rowKey}
  {group}
  {estimate}
  {scrollMemory}
  busy={loading || history?.loadingOlder}
  {loading}
  label="Conversation"
  {top}
  {placeholder}
  {footer}
  onviewport={rememberViewport}
  onreaderscroll={({ up }) => {
    if (up > 0 && !history?.loadingOlder) approachingHistory = true;
  }}
>
  {#snippet row(row: TimelineRow, index: number)}
    {#if row.kind === "date"}
      <div class={["pb-2", index > 0 && "pt-6"]}><ChatDateLine at={row.at} /></div>
    {:else if row.kind === "unread"}
      <div class="pt-4 pb-1"><UnreadDivider /></div>
    {:else if row.kind === "event-group"}
      <FeedFold open={openGroups.has(row.id)} ontoggle={() => toggleEvents(row.id)} class="py-1">
        <span class="font-medium tabular-nums"
          >{openGroups.has(row.id) ? "Hide" : "Show"} {row.events.length.toLocaleString("en")} events</span
        >
      </FeedFold>
    {:else if row.kind === "event"}
      <div class="py-2"><ChatEventLine event={row.event} /></div>
    {:else if row.kind === "exchanges"}
      <div class="py-2">
        <ExchangeLine segments={row.segments} hrefOf={(segment) => exchangeHref?.(segment) ?? "#"} />
      </div>
    {:else if row.kind === "error"}
      <div class="pt-3">
        <ChatErrorLine
          error={row.error}
          sender={row.sender}
          {retrying}
          onretry={watching ? undefined : onretry}
          onchangemodel={watching ? undefined : onchangemodel}
          onchangeworker={watching ? undefined : onchangeworker}
        />
      </div>
    {:else if row.kind === "question"}
      <div class="pt-3">
        <MessageRow
          sender={row.sender}
          showName={conversation.kind !== "direct"}
          gutter={conversation.kind !== "direct"}
          state={row.question.answer ? "done" : "waiting"}
        >
          <QuestionCard
            question={row.question}
            answering={answering[row.question.id]}
            onanswer={watching || !onanswer ? undefined : (optionId) => onanswer(row.question.id, optionId)}
          />
        </MessageRow>
      </div>
    {:else if row.kind === "approval"}
      <div class="pt-3">
        <MessageRow
          sender={row.sender}
          showName={conversation.kind !== "direct"}
          gutter={conversation.kind !== "direct"}
          state={row.approval.status === "pending" ? "waiting" : "done"}
        >
          <ApprovalCard
            approval={row.approval}
            answering={approvalAnswering(answering[row.approval.id])}
            onanswer={watching || !onapprove ? undefined : (answer) => onapprove(row.approval.id, answer)}
            {policy}
            {onpolicy}
          />
        </MessageRow>
      </div>
    {:else if row.kind === "message"}
      <div class={row.first ? "pt-3" : "pt-0.5"}>
        <ChatBubble
          conversationId={conversation.id}
          message={row.message}
          sender={row.sender}
          side={row.side}
          mine={row.mine}
          first={row.first}
          last={row.last}
          showName={row.showName}
          gutter={conversation.kind !== "direct"}
          {bots}
          replyToName={row.message.replyTo ? nameOf(row.message.replyTo.senderId) : undefined}
          onreact={watching ? undefined : onreact}
          onreply={watching ? undefined : onreply}
        />
      </div>
    {:else}
      <div class="pt-3">
        <BotStatusRow bot={row.status.bot} text={row.status.text} waiting={row.status.waiting} />
        {#if !row.status.waiting && row.status.text.startsWith("Waiting for") && onchangeworker && !watching}
          <div class="pl-9">
            <Button size="sm" variant="ghost" onclick={onchangeworker}>Change worker</Button>
            <p class="text-sm/6 text-zinc-600 dark:text-zinc-400">
              To use another worker for this message, stop this reply, change Runs on, then send the message again.
            </p>
          </div>
        {/if}
      </div>
    {/if}
  {/snippet}
</VirtualFeed>

{#if history?.historyError || history?.loadingOlder}
  <div class="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center px-4">
    <div
      class="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-x-2 rounded-xl bg-surface px-3 py-1.5 text-center text-sm text-muted shadow-sm ring-1 ring-divider"
    >
      {#if history.historyError}
        <p role="status">{history.historyError}</p>
        <Button size="sm" variant="ghost" onclick={() => void history?.loadOlder()}>Try again</Button>
      {:else}
        <p role="status" class="flex items-center gap-2"><Spinner />Loading earlier messages…</p>
      {/if}
    </div>
  </div>
{/if}

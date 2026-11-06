<script lang="ts">
  import { tick } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { rise } from "#lib/shared/ui/motion.ts";
  import { layoutChat, type ExchangeSegment } from "../chat-timeline.ts";
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
   * message. Entries that arrive while the chat is open rise in; the ones it opened with do not. In a
   * watched chat nothing can be answered or replied to.
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
    class: className,
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
    class?: ClassValue;
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
  const rows = $derived(layoutChat({ entries, participants, me: me.id, kind: conversation.kind, firstUnreadId }));
  const nameOf = (id: string) => participants.get(id)?.name;

  // The entries the chat opens with are already there; only later ones rise in.
  let live = $state(false);

  $effect(() => {
    if (entries.length > 0 && !live) void tick().then(() => (live = true));
  });

  const enter = (node: HTMLElement) => (live ? rise(node) : { duration: 0 });

  const approvalAnswering = (value: string | undefined) =>
    value === "approve" || value === "discard" || value === "edit" ? value : undefined;
</script>

<ol role="list" class={["flex flex-col", className]}>
  {#each rows as row (row.id)}
    {#if row.kind === "date"}
      <li class="pt-6 pb-2 first:pt-0" in:enter><ChatDateLine at={row.at} /></li>
    {:else if row.kind === "unread"}
      <li class="pt-4 pb-1"><UnreadDivider /></li>
    {:else if row.kind === "event"}
      <li class="py-2" in:enter><ChatEventLine event={row.event} /></li>
    {:else if row.kind === "exchanges"}
      <li class="py-2" in:enter>
        <ExchangeLine segments={row.segments} hrefOf={(segment) => exchangeHref?.(segment) ?? "#"} />
      </li>
    {:else if row.kind === "error"}
      <li class="pt-3" in:enter>
        <ChatErrorLine
          error={row.error}
          sender={row.sender}
          {retrying}
          onretry={watching ? undefined : onretry}
          onchangemodel={watching ? undefined : onchangemodel}
          onchangeworker={watching ? undefined : onchangeworker}
        />
      </li>
    {:else if row.kind === "question"}
      <li class="pt-3" in:enter>
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
      </li>
    {:else if row.kind === "approval"}
      <li class="pt-3" in:enter>
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
      </li>
    {:else}
      <li class={row.first ? "pt-3" : "pt-0.5"} in:enter>
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
      </li>
    {/if}
  {/each}
  {#if status}
    <li class="pt-3" in:rise out:rise={{}}>
      <BotStatusRow bot={status.bot} text={status.text} waiting={status.waiting} />
      {#if !status.waiting && status.text.startsWith("Waiting for") && onchangeworker && !watching}
        <div class="pl-9">
          <Button size="sm" variant="ghost" onclick={onchangeworker}>Change worker</Button>
          <p class="text-sm/6 text-zinc-600 dark:text-zinc-400">
            To use another worker for this message, stop this reply, change Runs on, then send the message again.
          </p>
        </div>
      {/if}
    </li>
  {/if}
</ol>

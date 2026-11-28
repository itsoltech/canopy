<script lang="ts">
  import { tick, untrack, type Snippet } from "svelte";
  import type { Mention, ui } from "@canopy/contracts";
  import CiteLayer from "#lib/features/quotes/CiteLayer.svelte";
  import { useQuoteDrafts } from "#lib/features/quotes/quote-drafts.svelte.ts";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import type { ClassValue } from "svelte/elements";
  import type { ExchangeSegment } from "../chat-timeline.ts";
  import type {
    BotStatusView,
    ChatEntry,
    ChatMessageView,
    ConversationView,
    ParticipantView,
  } from "@canopy/domain/bot-chat";
  import type { ChatHistory } from "../chat-history.ts";
  import type { MascotState } from "../behaviour.ts";
  import { stateForStatus } from "../behaviour-math.ts";
  import type { ApprovalAnswer, ApprovalPolicy } from "./ApprovalCard.svelte";
  import BotComposer from "./BotComposer.svelte";
  import ChatTimeline from "./ChatTimeline.svelte";
  import ConversationHeader from "./ConversationHeader.svelte";
  import WatchBar from "./WatchBar.svelte";
  import ConversationSkeleton from "./ConversationSkeleton.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import type { BotComposerDraft } from "../composer-draft.svelte.ts";
  import { FileIntake, provideFileIntake } from "#lib/features/attachments/file-intake.svelte.ts";
  import { provideCitationSource } from "#lib/features/quotes/citation-source.ts";
  import { revealBotCitation } from "../citation-source.ts";

  /**
   * A whole bot chat: header, the scrolling conversation (opens at the "New" divider, else at the end) and
   * the composer, or the bar with "Close chat" in a bot ⇄ bot chat you only read. The conversation follows
   * new messages (and what the bot is doing) only while you are at the bottom; scrolled up, a button takes
   * you back down. Reply puts a quote of the message into the composer.
   */
  let {
    conversation,
    loading = false,
    syncing = false,
    history,
    entries,
    me,
    directory = [],
    subtitle,
    firstUnreadId,
    status,
    answering,
    retrying = false,
    policy,
    sending = false,
    running = false,
    stopping = false,
    onstop,
    composerDraft,
    composerDisabledReason,
    exchangeHref,
    onsend,
    onanswer,
    onapprove,
    onpolicy,
    onretry,
    onchangemodel,
    onchangeworker,
    onreact,
    onclose,
    onattach,
    actions,
    notice,
    archived,
    class: className,
  }: {
    conversation: ConversationView;
    loading?: boolean;
    syncing?: boolean;
    history?: ChatHistory | undefined;
    entries: readonly ChatEntry[];
    me: ParticipantView;
    directory?: readonly ParticipantView[];
    subtitle?: string | undefined;
    firstUnreadId?: string | undefined;
    status?: BotStatusView | undefined;
    answering?: Readonly<Record<string, string>>;
    retrying?: boolean;
    policy?: ApprovalPolicy | undefined;
    sending?: boolean;
    running?: boolean;
    stopping?: boolean;
    onstop?: (() => void) | undefined;
    composerDraft?: BotComposerDraft | undefined;
    /** Set when you cannot write right now (e.g. the bot is unavailable); shown in the box. */
    composerDisabledReason?: string | undefined;
    exchangeHref?: ((segment: ExchangeSegment) => string) | undefined;
    onsend: (
      text: string,
      mentions: Mention[],
      quotes: ui.Quote[],
      attachments?: ui.Attachment[],
      requestId?: string,
      revision?: bigint,
    ) => void | Promise<boolean | void>;
    onanswer?: ((questionId: string, optionId: string) => void) | undefined;
    onapprove?: ((approvalId: string, answer: ApprovalAnswer) => void) | undefined;
    onpolicy?: ((policy: ApprovalPolicy) => void) | undefined;
    onretry?: (() => void) | undefined;
    onchangemodel?: (() => void) | undefined;
    onchangeworker?: (() => void) | undefined;
    onreact?: ((messageId: string, emoji: string, active: boolean) => void) | undefined;
    onclose?: (() => void) | undefined;
    onattach?: (() => void) | undefined;
    actions?: Snippet;
    /** Availability or migration notices scroll below the window's conversation header. */
    notice?: Snippet;
    archived?: Snippet;
    class?: ClassValue;
  } = $props();

  let draft = $state("");
  let draftMentions = $state<Mention[]>([]);
  const quoteDrafts = useQuoteDrafts();
  const quoteKey = $derived(`bot:${conversation.id}`);
  let composerRegion = $state<HTMLElement>();
  const intake = new FileIntake();

  provideFileIntake(intake);

  $effect(() => {
    const current = composerDraft;

    if (!current) return;
    void current.sync.load();

    return () => {
      void current.sync.flush().catch(() => {});
    };
  });

  $effect(() => {
    const current = composerDraft;

    if (!current) return;
    void current.text;
    void current.mentions;
    void current.loaded;
    void current.files.files.map((f) => f.status);
    void quoteDrafts.list(current.quoteKey);
    untrack(() => current.persist());
  });

  let timeline = $state<ReturnType<typeof ChatTimeline>>();
  let timelineRegion = $state<HTMLElement>();
  let composer = $state<ReturnType<typeof BotComposer>>();

  /** Scrolls a card or message of this conversation into view. */
  export const reveal = (id: string) => timeline?.reveal(id) ?? Promise.resolve(false);

  provideCitationSource((quote) => {
    const chat = timeline;

    return revealBotCitation(quote, {
      get entries() {
        return timeline === chat ? entries : [];
      },
      get root() {
        return timeline === chat ? timelineRegion : undefined;
      },
      get history() {
        return timeline === chat ? history : undefined;
      },
      reveal: (id) => chat?.reveal(id) ?? Promise.resolve(false),
    });
  });

  // Living mascots: the header's bot reacts to a new message (`event`) and shows what it is doing.
  let messageEvent = $state(0);
  let previousMessage: string | undefined;
  let previousConversation: string | undefined;

  $effect(() => {
    const id = conversation.id;

    const found = entries.findLast(
      (entry) => entry.kind === "message" || (entry.kind === "event" && entry.event.changes?.length),
    );

    const latest = found?.kind === "message" ? found.message.id : found?.kind === "event" ? found.event.id : undefined;

    if (previousConversation === id && latest && latest !== previousMessage) untrack(() => messageEvent++);
    previousConversation = id;
    previousMessage = latest;
  });

  const mascotState = $derived.by((): MascotState => {
    if (status) return status.waiting ? "waiting" : stateForStatus(status.text);
    const last = entries.at(-1);

    if (last?.kind === "error") return "error";

    if (sending) return "working";

    return last?.kind === "message" && conversation.bots.some((bot) => bot.id === last.message.senderId)
      ? "done"
      : "idle";
  });

  // Your own message goes to the end of the conversation: follow it there.
  function send(text: string, mentions: Mention[], quotes: ui.Quote[]) {
    timeline?.followLatest();
    void onsend(text, mentions, quotes);
  }

  function reply(message: ChatMessageView) {
    const added = quoteDrafts.add(quoteKey, {
      text: message.text,
      source: {
        itemId: message.id,
        threadId: conversation.id,
        kind: "agent_message_markdown",
        language: "",
        author: conversation.bots.find((b) => b.id === message.senderId)?.name || "Agent",
        time: message.at.toLocaleString(),
      },
    });

    if (!added) toast("A message can carry up to 20 quotes", { tone: "error" });
    void tick().then(() => composer?.focus());
  }
</script>

<div
  data-mascot-chat
  class={[
    "relative flex h-full min-h-0 flex-col bg-canvas [--feed-backdrop:var(--color-canvas)] [--feed-column-width:var(--bot-chat-width)]",
    className,
  ]}
  {@attach intake.zone}
>
  <div class="relative flex min-h-0 flex-1 flex-col">
    <ConversationHeader {conversation} {subtitle} state={mascotState} event={messageEvent} class="relative z-10">
      {#snippet actions()}
        <span
          role="status"
          class="w-16 shrink-0 text-right text-xs text-zinc-500 dark:text-zinc-400"
          class:invisible={!syncing}>Syncing…</span
        >
        {@render actions?.()}
      {/snippet}
    </ConversationHeader>
    <div class="relative min-h-0 flex-1" bind:this={timelineRegion}>
      <ChatTimeline
        bind:this={timeline}
        {conversation}
        {entries}
        {me}
        {directory}
        {firstUnreadId}
        {status}
        {answering}
        {retrying}
        {policy}
        {exchangeHref}
        {onanswer}
        {onapprove}
        {onpolicy}
        {onretry}
        {onchangemodel}
        {onchangeworker}
        {onreact}
        {history}
        {loading}
        {syncing}
        top={notice}
        onreply={conversation.kind === "watch" || conversation.archived ? undefined : reply}
      >
        {#snippet placeholder()}
          {#if loading}<ConversationSkeleton />{/if}
        {/snippet}
        {#snippet footer()}
          <div bind:this={composerRegion}>
            {#if archived && conversation.archived}
              {@render archived()}
            {:else if conversation.kind === "watch"}
              <WatchBar {onclose} />
            {:else}
              <BotComposer
                bind:this={composer}
                bind:value={
                  () => composerDraft?.text ?? draft,
                  (value) => {
                    if (composerDraft) composerDraft.text = value;
                    else draft = value;
                  }
                }
                bind:mentions={
                  () => composerDraft?.mentions ?? draftMentions,
                  (value) => {
                    if (composerDraft) composerDraft.mentions = value;
                    else draftMentions = value;
                  }
                }
                botId={conversation.id}
                {quoteKey}
                placeholder={conversation.bots.length === 1 ? `Message ${conversation.bots[0]!.name}` : "Message"}
                sending={sending || composerDraft?.sending}
                {running}
                {stopping}
                onstop={composerDisabledReason ? undefined : onstop}
                files={composerDraft?.files}
                durable={Boolean(composerDraft)}
                disabled={Boolean(composerDisabledReason) || Boolean(composerDraft && !composerDraft.loaded)}
                disabledReason={composerDisabledReason}
                onsend={send}
                {onattach}
              />
              {#if composerDraft?.error}<p role="status" class="px-3 pt-2 text-sm text-rose-600 dark:text-rose-400">
                  {composerDraft.error}
                </p>
                <Button size="sm" variant="ghost" onclick={() => void composerDraft?.sync.reload()}
                  >Load saved draft</Button
                >
              {/if}
            {/if}
          </div>
        {/snippet}
      </ChatTimeline>
    </div>
  </div>
  {#if intake.dragging}<div
      class="pointer-events-none absolute inset-2 z-30 grid place-items-center rounded-2xl border-2 border-dashed border-brand-500 bg-white/90 dark:bg-zinc-950/90"
    >
      <p>Drop files to attach</p>
    </div>{/if}
</div>
{#if conversation.kind !== "watch" && !conversation.archived}<CiteLayer
    threadId={quoteKey}
    root={timelineRegion}
    avoid={composerRegion}
  />{/if}

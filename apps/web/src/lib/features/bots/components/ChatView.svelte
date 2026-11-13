<script lang="ts">
  import { tick, untrack, type Snippet } from "svelte";
  import type { Mention, ui } from "@canopy/contracts";
  import CiteLayer from "#lib/features/quotes/CiteLayer.svelte";
  import { useQuoteDrafts } from "#lib/features/quotes/quote-drafts.svelte.ts";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import type { ClassValue } from "svelte/elements";
  import { rise } from "#lib/shared/ui/motion.ts";
  import type { ExchangeSegment } from "../chat-timeline.ts";
  import type {
    BotStatusView,
    ChatEntry,
    ChatMessageView,
    ConversationView,
    ParticipantView,
  } from "@canopy/domain/bot-chat";
  import type { MascotState } from "../behaviour.ts";
  import { stateForStatus } from "../behaviour-math.ts";
  import type { ApprovalAnswer, ApprovalPolicy } from "./ApprovalCard.svelte";
  import BotComposer from "./BotComposer.svelte";
  import ChatTimeline from "./ChatTimeline.svelte";
  import ConversationHeader from "./ConversationHeader.svelte";
  import RoundButton from "./RoundButton.svelte";
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
    hasMore = false,
    loadingOlder = false,
    historyError = "",
    onloadOlder,
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
    hasMore?: boolean;
    loadingOlder?: boolean;
    historyError?: string;
    onloadOlder?: (() => Promise<void>) | undefined;
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
    onreact?: ((message: ChatMessageView) => void) | undefined;
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

  /** Height of the floating composer: the conversation scrolls under it and keeps that much room at its end. */
  let composerHeight = $state(0);

  /** The log's scrollbar width: the fade stops short of it. */
  let gutter = $state(0);

  $effect(() => {
    if (!log) return;
    const measure = () => (gutter = log ? log.offsetWidth - log.clientWidth : 0);
    const observer = new ResizeObserver(measure);
    observer.observe(log);
    measure();

    return () => observer.disconnect();
  });

  let log = $state<HTMLElement>();
  let content = $state<HTMLElement>();
  let composer = $state<ReturnType<typeof BotComposer>>();
  let following = $state(true);
  let startIndex = $state<number>();
  let openedHistory = false;
  const historyStart = $derived(startIndex ?? Math.max(0, entries.length - 100));
  const visibleEntries = $derived(entries.slice(historyStart));

  provideCitationSource((quote) =>
    revealBotCitation(quote, {
      get entries() {
        return entries;
      },
      get hasMore() {
        return hasMore;
      },
      get root() {
        return log;
      },
      get load() {
        return onloadOlder;
      },
      show: (index) => {
        following = false;
        startIndex = Math.min(historyStart, index);
      },
    }),
  );

  $effect(() => {
    if (!loading && !openedHistory && entries.length) {
      openedHistory = true;
      startIndex = Math.max(0, entries.length - 100);
    }
  });

  async function showEarlier() {
    if (!log || loadingOlder) return;
    const top = log.scrollTop;
    const height = log.scrollHeight;
    following = false;

    if (historyStart > 0) startIndex = Math.max(0, historyStart - 100);
    else await onloadOlder?.();
    await tick();
    log.scrollTop = top + log.scrollHeight - height;
  }

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

  const toEnd = (behavior: ScrollBehavior = "instant") => log?.scrollTo({ top: log.scrollHeight, behavior });

  // The measured inset changes the log's padding without resizing its messages. Keep the latest message
  // above a growing editor or safe area, while preserving the position of readers scrolling back.
  $effect(() => {
    void composerHeight;

    if (untrack(() => following))
      void tick().then(() => {
        if (following) toEnd();
      });
  });

  // Whatever grows the conversation (a message, a card, the status line, a long answer) keeps the end in
  // view while you are there.
  $effect(() => {
    const node = content;

    if (!node) return;

    const observer = new ResizeObserver(() => {
      if (following) toEnd();
    });

    observer.observe(node);

    return () => observer.disconnect();
  });

  // Your own message goes to the end of the conversation: follow it there.
  function send(text: string, mentions: Mention[], quotes: ui.Quote[]) {
    following = true;

    if (composerDraft) void composerDraft.send(onsend);
    else void onsend(text, mentions, quotes);
    void tick().then(() => toEnd());
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

  function openAtUnread(node: HTMLElement) {
    const divider = node.querySelector<HTMLElement>("[role=separator][aria-label='New messages']");
    following = !divider;

    if (divider) node.scrollTop = divider.offsetTop - node.clientHeight / 3;
    else node.scrollTop = node.scrollHeight;
  }
</script>

<div data-mascot-chat class={["relative flex h-full min-h-0 flex-col", className]} {@attach intake.zone}>
  <div class="relative flex min-h-0 flex-1 flex-col">
    <!-- Over the conversation, frosted: messages scrolling under it stay faintly visible. The log starts below it
         (scroll-padding keeps focused and jumped-to messages clear of it). -->
    <ConversationHeader
      {conversation}
      {subtitle}
      state={mascotState}
      event={messageEvent}
      class="absolute inset-x-0 top-0 z-10 bg-white/75 backdrop-blur-md backdrop-saturate-150 dark:bg-black/70"
    >
      {#snippet actions()}
        <span
          role="status"
          class="w-16 shrink-0 text-right text-xs text-zinc-500 dark:text-zinc-400"
          class:invisible={!syncing}>Syncing…</span
        >
        {@render actions?.()}
      {/snippet}
    </ConversationHeader>
    <!-- `relative`: screen-reader labels positioned inside messages stay inside the scroller. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="relative min-h-0 flex-1 scroll-pt-14 scroll-stable overflow-y-auto overscroll-contain pt-14 focus:outline-none"
      style:padding-bottom="{composerHeight}px"
      style:scroll-padding-bottom="{composerHeight}px"
      role="log"
      aria-label="Conversation"
      tabindex="0"
      bind:this={log}
      onscroll={() => {
        if (log) following = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
        if (log && log.scrollTop < 80 && !following && (historyStart > 0 || hasMore)) void showEarlier();
      }}
      {@attach openAtUnread}
    >
      <div bind:this={content}>
        {@render notice?.()}
        {#if loading}
          <ConversationSkeleton />
        {:else}
          {#if historyStart > 0 || hasMore}<div class="flex justify-center py-3">
              <Button size="sm" variant="ghost" disabled={loadingOlder} onclick={() => void showEarlier()}
                >{loadingOlder ? "Loading earlier messages…" : "Show earlier messages"}</Button
              >
            </div>{/if}
          {#if historyError}<p class="px-4 py-2 text-center text-sm text-zinc-500 dark:text-zinc-400">
              {historyError}
            </p>{/if}
          <ChatTimeline
            {conversation}
            entries={visibleEntries}
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
            onreply={conversation.kind === "watch" || conversation.archived ? undefined : reply}
            class="mx-auto w-full max-w-(--bot-chat-width) px-3 pt-4 pb-6 sm:px-6"
          />
        {/if}
      </div>
    </div>
    {#if !following}
      <!-- Centred by flex, not translate: rise animates `translate` and would cancel a -translate-x-1/2. -->
      <div
        class="pointer-events-none absolute inset-x-0 z-20 flex justify-center"
        style:bottom="{composerHeight + 12}px"
        transition:rise
      >
        <span
          class="pointer-events-auto flex rounded-full bg-white shadow-md ring-1 ring-zinc-950/10 dark:bg-zinc-800 dark:shadow-none dark:ring-white/10"
        >
          <RoundButton
            icon="arrow-down"
            label="Jump to the latest message"
            variant="secondary"
            onclick={() => {
              following = true;
              toEnd("smooth");
            }}
          />
        </span>
      </div>
    {/if}

    <!-- Floats over the end of the conversation (sticky bottom): messages fade out under it. -->
    <div
      class="pointer-events-none absolute bottom-0 left-0 z-10 bg-linear-to-t from-white from-[calc(100%-2rem)] to-transparent dark:from-black"
      style:right="{gutter}px"
      style:height="{composerHeight + 32}px"
      aria-hidden="true"
    ></div>
    <div
      bind:this={composerRegion}
      bind:clientHeight={composerHeight}
      class="absolute inset-x-0 bottom-0 z-10 mx-auto w-full max-w-(--bot-chat-width) px-3 pt-1 composer-bottom sm:px-6"
    >
      {#if archived && conversation.archived}
        {@render archived()}
      {:else if conversation.kind === "watch"}
        <WatchBar bots={conversation.bots} {onclose} />
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
          <Button size="sm" variant="ghost" onclick={() => void composerDraft?.sync.reload()}>Load saved draft</Button>
        {/if}
      {/if}
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
    root={log}
    avoid={composerRegion}
  />{/if}

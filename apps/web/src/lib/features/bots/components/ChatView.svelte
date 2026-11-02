<script lang="ts">
  import { tick, untrack, type Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import type { ChatEntry, ChatMessageView, ConversationView, ParticipantView } from "../model.ts";
  import BotComposer from "./BotComposer.svelte";
  import ChatTimeline from "./ChatTimeline.svelte";
  import ConversationHeader from "./ConversationHeader.svelte";
  import WatchBar from "./WatchBar.svelte";
  import BotActivity, { type BotActivityView } from "./BotActivity.svelte";
  import { stateForStatus, type MascotState } from "../behaviour-math.ts";

  /**
   * A whole bot chat: header, the scrolling conversation (opens at the "New" divider, else at the
   * end) and the composer, or the read-only bar with "Close chat" in a watched bot ⇄ bot chat.
   */
  let {
    conversation,
    entries,
    me,
    firstUnreadId,
    answering,
    sending = false,
    statusLine = "",
    composerDisabledReason,
    onsend,
    onanswer,
    onreact,
    onreply,
    onclose,
    onattach,
    onrecord,
    actions,
    botActivity,
    class: className,
  }: {
    conversation: ConversationView;
    entries: readonly ChatEntry[];
    me: ParticipantView;
    firstUnreadId?: string | undefined;
    answering?: Readonly<Record<string, string>>;
    sending?: boolean;
    statusLine?: string;
    /** Set when you cannot write right now (e.g. the bot is unavailable); shown in the box. */
    composerDisabledReason?: string | undefined;
    onsend: (text: string) => void;
    onanswer?: ((questionId: string, optionId: string) => void) | undefined;
    onreact?: ((message: ChatMessageView) => void) | undefined;
    onreply?: ((message: ChatMessageView) => void) | undefined;
    onclose?: (() => void) | undefined;
    onattach?: (() => void) | undefined;
    onrecord?: (() => void) | undefined;
    actions?: Snippet;
    /** Optional live state from bots-core; absent callers retain the presentational API. */
    botActivity?: readonly BotActivityView[];
    class?: ClassValue;
  } = $props();

  let draft = $state("");
  let log = $state<HTMLElement>();
  let messageEvent = $state(0);
  let previousMessage: string | undefined;
  let previousConversation: string | undefined;
  $effect(() => {
    const id = conversation.id;
    const messages = entries.filter((entry) => entry.kind === "message");
    const latest = messages.at(-1)?.message.id;
    if (previousConversation === id && latest && latest !== previousMessage) {
      untrack(() => messageEvent++);
    }
    previousConversation = id;
    previousMessage = latest;
  });
  const mascotState = $derived.by((): MascotState => {
    if (botActivity?.[0]) return botActivity[0].state;
    if (statusLine) return stateForStatus(statusLine);
    const question = entries.findLast((entry) => entry.kind === "question" && !entry.question.answer);
    if (question) return "waiting";
    if (sending) return "working";
    const latest = entries.findLast((entry) => entry.kind === "message");
    return latest?.kind === "message" && conversation.bots.some((bot) => bot.id === latest.message.senderId) ? "done" : "idle";
  });
  let following = $state(true);

  $effect(() => {
    entries.length;
    const node = log;
    if (node && untrack(() => following)) void tick().then(() => node.scrollTo({ top: node.scrollHeight }));
  });

  // Your own message goes to the end of the conversation: follow it there.
  function send(text: string) {
    following = true;
    onsend(text);
    void tick().then(() => log?.scrollTo({ top: log.scrollHeight }));
  }

  function openAtUnread(node: HTMLElement) {
    const divider = node.querySelector<HTMLElement>("[role=separator][aria-label='New messages']");
    following = !divider;
    if (divider) node.scrollTop = divider.offsetTop - node.clientHeight / 3;
    else node.scrollTop = node.scrollHeight;
  }
</script>

<div data-mascot-chat class={["flex h-full min-h-0 flex-col", className]}>
  <ConversationHeader {conversation} {actions} {statusLine} state={mascotState} event={messageEvent} />
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="min-h-0 flex-1 overflow-y-auto focus:outline-none" role="log" aria-label="Conversation" tabindex="0" bind:this={log} onscroll={() => { if (log) following = log.scrollHeight - log.scrollTop - log.clientHeight < 80; }} {@attach openAtUnread}>
    <ChatTimeline
      {conversation}
      {entries}
      {me}
      {firstUnreadId}
      {answering}
      {onanswer}
      {onreact}
      {onreply}
      class="mx-auto w-full max-w-(--chat-width) px-3 py-4 sm:px-6"
    />
    {#each botActivity ?? [] as activity (activity.botId)}
      {@const bot = conversation.bots.find((bot) => bot.id === activity.botId)}
      {#if bot}
        <BotActivity {bot} state={activity.state} label={activity.label} event={messageEvent} class="mx-auto w-full max-w-(--chat-width) px-3 pb-4 sm:px-6" />
      {/if}
    {/each}
  </div>
  <div class="mx-auto w-full max-w-(--chat-width) shrink-0 px-3 pt-2 pb-3 sm:px-6 sm:pb-4">
    {#if conversation.kind === "watch"}
      <WatchBar bots={conversation.bots} {onclose} />
    {:else}
      <BotComposer bind:value={draft} {sending} disabled={Boolean(composerDisabledReason)} disabledReason={composerDisabledReason} onsend={send} {onattach} {onrecord} />
    {/if}
  </div>
</div>

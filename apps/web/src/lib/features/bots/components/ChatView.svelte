<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import type { ChatEntry, ChatMessageView, ConversationView, ParticipantView } from "../model.ts";
  import BotComposer from "./BotComposer.svelte";
  import ChatTimeline from "./ChatTimeline.svelte";
  import ConversationHeader from "./ConversationHeader.svelte";
  import WatchBar from "./WatchBar.svelte";

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
    composerDisabledReason,
    onsend,
    onanswer,
    onreact,
    onreply,
    onclose,
    onattach,
    onrecord,
    actions,
    class: className,
  }: {
    conversation: ConversationView;
    entries: readonly ChatEntry[];
    me: ParticipantView;
    firstUnreadId?: string | undefined;
    answering?: Readonly<Record<string, string>>;
    sending?: boolean;
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
    class?: ClassValue;
  } = $props();

  let draft = $state("");

  function openAtUnread(node: HTMLElement) {
    const divider = node.querySelector<HTMLElement>("[role=separator][aria-label='New messages']");
    if (divider) node.scrollTop = divider.offsetTop - node.clientHeight / 3;
    else node.scrollTop = node.scrollHeight;
  }
</script>

<div class={["flex h-full min-h-0 flex-col", className]}>
  <ConversationHeader {conversation} {actions} />
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="min-h-0 flex-1 overflow-y-auto focus:outline-none" role="log" aria-label="Conversation" tabindex="0" {@attach openAtUnread}>
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
  </div>
  <div class="mx-auto w-full max-w-(--chat-width) shrink-0 px-3 pt-2 pb-3 sm:px-6 sm:pb-4">
    {#if conversation.kind === "watch"}
      <WatchBar bots={conversation.bots} {onclose} />
    {:else}
      <BotComposer bind:value={draft} {sending} disabled={Boolean(composerDisabledReason)} disabledReason={composerDisabledReason} {onsend} {onattach} {onrecord} />
    {/if}
  </div>
</div>

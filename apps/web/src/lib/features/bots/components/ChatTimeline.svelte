<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { layoutChat } from "../chat-timeline.ts";
  import type { ChatEntry, ChatMessageView, ConversationView, ParticipantView } from "../model.ts";
  import ChatBubble from "./ChatBubble.svelte";
  import ChatDateLine from "./ChatDateLine.svelte";
  import ChatEventLine from "./ChatEventLine.svelte";
  import MessageRow from "./MessageRow.svelte";
  import QuestionCard from "./QuestionCard.svelte";
  import UnreadDivider from "./UnreadDivider.svelte";

  /**
   * The entries of a conversation, laid out by `layoutChat`: date lines, the "New" divider, runs of
   * bubbles, event lines and question cards. In a watched chat the second bot writes on the right
   * and nothing can be answered or replied to.
   */
  let {
    conversation,
    entries,
    me,
    firstUnreadId,
    answering = {},
    onanswer,
    onreact,
    onreply,
    class: className,
  }: {
    conversation: ConversationView;
    entries: readonly ChatEntry[];
    me: ParticipantView;
    firstUnreadId?: string | undefined;
    /** Question id → option being sent. */
    answering?: Readonly<Record<string, string>>;
    onanswer?: ((questionId: string, optionId: string) => void) | undefined;
    onreact?: ((message: ChatMessageView) => void) | undefined;
    onreply?: ((message: ChatMessageView) => void) | undefined;
    class?: ClassValue;
  } = $props();

  const watching = $derived(conversation.kind === "watch");
  const participants = $derived(new Map<string, ParticipantView>([[me.id, me], ...conversation.bots.map((b) => [b.id, b] as const)]));
  const rows = $derived(
    layoutChat({ entries, participants, me: me.id, kind: conversation.kind, endSideId: watching ? conversation.bots[1]?.id : undefined, firstUnreadId }),
  );
  const nameOf = (id: string) => participants.get(id)?.name;
</script>

<ol role="list" class={["flex flex-col", className]}>
  {#each rows as row (row.id)}
    {#if row.kind === "date"}
      <li class="pt-6 pb-2 first:pt-0"><ChatDateLine at={row.at} /></li>
    {:else if row.kind === "unread"}
      <li class="pt-4 pb-1"><UnreadDivider /></li>
    {:else if row.kind === "event"}
      <li class="py-2"><ChatEventLine event={row.event} /></li>
    {:else if row.kind === "question"}
      <li class="pt-3">
        <MessageRow sender={row.sender} showName={conversation.kind !== "direct"} state={row.question.answer ? "done" : "waiting"}>
          <QuestionCard
            question={row.question}
            answering={answering[row.question.id]}
            onanswer={watching || !onanswer ? undefined : (optionId) => onanswer(row.question.id, optionId)}
          />
        </MessageRow>
      </li>
    {:else}
      <li class={row.first ? "pt-3" : "pt-0.5"}>
        <ChatBubble
          message={row.message}
          sender={row.sender}
          side={row.side}
          mine={row.mine}
          first={row.first}
          last={row.last}
          showName={row.showName}
          replyToName={row.message.replyTo ? nameOf(row.message.replyTo.senderId) : undefined}
          onreact={watching ? undefined : onreact}
          onreply={watching ? undefined : onreply}
        />
      </li>
    {/if}
  {/each}
</ol>

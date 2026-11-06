<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ConversationHandlers } from "../actions.ts";
  import { arrangeConversations, byLatest, conversationTitle, type ConversationView } from "@canopy/domain/bot-chat";
  import BotListItem from "./BotListItem.svelte";
  import GroupListItem from "./GroupListItem.svelte";
  import PinnedConversations from "./PinnedConversations.svelte";

  /**
   * The Bots section of the sidebar: pinned conversations as large avatars on top, then the other
   * 1:1, group and watched chats by latest message. `query` filters by name, bot and last message;
   * while searching, pinned ones are listed as rows with the rest.
   */
  let {
    conversations,
    hrefOf,
    currentId,
    query = "",
    class: className,
    ...handlers
  }: {
    conversations: readonly ConversationView[];
    hrefOf: (conversation: ConversationView) => string;
    currentId?: string | undefined;
    query?: string;
    class?: ClassValue;
  } & ConversationHandlers = $props();

  const q = $derived(query.trim().toLowerCase());

  const matches = (c: ConversationView) =>
    [conversationTitle(c), ...c.bots.map((b) => b.name), c.lastMessage?.text ?? ""].some((text) =>
      text.toLowerCase().includes(q),
    );

  const arranged = $derived(
    q ? { pinned: [], others: byLatest(conversations.filter(matches)) } : arrangeConversations(conversations),
  );
</script>

<div
  class={[
    "grid grid-cols-1 gap-2 [--avatar-ring:var(--color-zinc-50)] dark:[--avatar-ring:var(--color-zinc-950)]",
    className,
  ]}
>
  {#if arranged.pinned.length > 0}
    <PinnedConversations conversations={arranged.pinned} {hrefOf} {currentId} {...handlers} />
  {/if}
  {#if arranged.others.length > 0}
    <ul role="list" aria-label={q ? "Matching chats" : "Chats"} class="grid gap-0.5">
      {#each arranged.others as conversation (conversation.id)}
        <li>
          {#if conversation.kind === "direct"}
            <BotListItem
              {conversation}
              href={hrefOf(conversation)}
              current={conversation.id === currentId}
              {...handlers}
            />
          {:else}
            <GroupListItem
              {conversation}
              href={hrefOf(conversation)}
              current={conversation.id === currentId}
              {...handlers}
            />
          {/if}
        </li>
      {/each}
    </ul>
  {:else if q}
    <p class="px-3 py-2 text-sm/6 text-pretty text-zinc-500 dark:text-zinc-400">No bot or chat matches “{query}”.</p>
  {/if}
</div>

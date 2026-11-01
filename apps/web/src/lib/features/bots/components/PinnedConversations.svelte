<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ConversationHandlers } from "../actions.ts";
  import type { ConversationView } from "../model.ts";
  import PinnedTile from "./PinnedTile.svelte";

  /** Pinned bots and groups as a grid of large avatars (four per line, wrapping), in pin order. */
  let {
    conversations,
    hrefOf,
    currentId,
    class: className,
    ...handlers
  }: { conversations: readonly ConversationView[]; hrefOf: (conversation: ConversationView) => string; currentId?: string | undefined; class?: ClassValue } & ConversationHandlers = $props();
  const id = $props.id();
</script>

<section aria-labelledby="{id}-title" class={className}>
  <h2 id="{id}-title" class="sr-only">Pinned</h2>
  <p id="{id}-hint" class="sr-only">Press Shift+F10 or long-press a pinned chat for its actions.</p>
  <ul role="list" class="grid grid-cols-4 gap-1">
    {#each conversations as conversation (conversation.id)}
      <li class="min-w-0">
        <PinnedTile {conversation} href={hrefOf(conversation)} current={conversation.id === currentId} hint="{id}-hint" class="w-full" {...handlers} />
      </li>
    {/each}
  </ul>
</section>

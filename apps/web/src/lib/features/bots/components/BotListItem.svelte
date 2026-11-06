<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ConversationHandlers } from "../actions.ts";
  import type { ConversationView } from "@canopy/domain/bot-chat";
  import BotAvatar from "./BotAvatar.svelte";
  import ConversationRow from "./ConversationRow.svelte";

  /** A 1:1 chat with a bot in the Bots list. */
  let {
    conversation,
    href,
    current = false,
    class: className,
    ...handlers
  }: {
    conversation: ConversationView;
    href: string;
    current?: boolean;
    class?: ClassValue;
  } & ConversationHandlers = $props();

  const bot = $derived(conversation.bots[0]);
</script>

<ConversationRow {conversation} {href} {current} class={className} {...handlers}>
  {#snippet avatar()}
    {#if bot}<BotAvatar participant={bot} />{/if}
  {/snippet}
</ConversationRow>

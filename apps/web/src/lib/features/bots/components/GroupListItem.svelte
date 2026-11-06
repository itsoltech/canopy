<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ConversationHandlers } from "../actions.ts";
  import type { ConversationView } from "@canopy/domain/bot-chat";
  import AvatarStack from "./AvatarStack.svelte";
  import ConversationRow from "./ConversationRow.svelte";

  /** A group chat (you and several bots) or a watched bot ⇄ bot chat in the Bots list. */
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
</script>

<ConversationRow {conversation} {href} {current} class={className} {...handlers}>
  {#snippet avatar()}
    <AvatarStack participants={conversation.bots} layout="square" />
  {/snippet}
</ConversationRow>

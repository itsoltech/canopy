<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import { anchorOnly } from "#lib/shared/ui/Popover.svelte";
  import { conversationMenu, type ConversationHandlers } from "../actions.ts";
  import { avatarRing } from "../avatar-ring.ts";
  import { contextMenu } from "../context-menu.ts";
  import { conversationTitle, type ConversationView } from "@canopy/domain/bot-chat";
  import AvatarBadge from "./AvatarBadge.svelte";
  import AvatarStack from "./AvatarStack.svelte";
  import BotAvatar from "./BotAvatar.svelte";
  import ActionItems from "./ActionItems.svelte";

  /**
   * A pinned conversation at the top of the Bots section: a large avatar with the star badge and the
   * name under it. Its actions (unpin, mark as read) open with a right click, the Menu key,
   * Shift+F10 or a long press. `hint` is the id of the text that tells keyboard users so.
   */
  let {
    conversation,
    href,
    current = false,
    hint,
    class: className,
    ...handlers
  }: {
    conversation: ConversationView;
    href: string;
    current?: boolean;
    hint?: string | undefined;
    class?: ClassValue;
  } & ConversationHandlers = $props();

  let menuOpen = $state(false);
  const title = $derived(conversationTitle(conversation));
  const items = $derived(conversationMenu(conversation, handlers));
</script>

<DropdownMenu label="Actions for {title}" bind:open={menuOpen}>
  {#snippet trigger(props)}
    <a
      {...anchorOnly(props)}
      {href}
      aria-current={current ? "page" : undefined}
      aria-describedby={hint}
      {title}
      class={[
        "group flex w-full min-w-0 flex-col items-center gap-1.5 rounded-xl px-0.5 pt-2 pb-1.5 focus-ring select-none [-webkit-touch-callout:none] hover:bg-zinc-950/4 aria-[current=page]:bg-zinc-950/6 dark:hover:bg-white/4 dark:aria-[current=page]:bg-white/8",
        className,
      ]}
      {@attach contextMenu(() => (menuOpen = items.length > 0))}
    >
      <span class="relative flex">
        {#if conversation.kind === "direct" && conversation.bots[0]}
          <BotAvatar participant={conversation.bots[0]} size="lg" badge="pinned" />
        {:else}
          <AvatarStack participants={conversation.bots} layout="square" size="lg" />
          <AvatarBadge kind="pinned" size="lg" />
        {/if}
        {#if conversation.unread > 0}
          <span class={["absolute top-0 right-0 size-3 rounded-full bg-brand-500", avatarRing]}></span>
        {/if}
      </span>
      <span
        class="w-full truncate text-center text-sm/5 text-zinc-700 group-aria-[current=page]:text-zinc-950 sm:text-xs/5 dark:text-zinc-300 dark:group-aria-[current=page]:text-white"
      >
        {title}{#if conversation.unread > 0}<span class="sr-only">, {conversation.unread} unread</span>{/if}
      </span>
    </a>
  {/snippet}
  <ActionItems actions={items} />
</DropdownMenu>

<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { conversationMenu, type ConversationHandlers } from "../actions.ts";
  import { listTimeLabel } from "../chat-timeline.ts";
  import { contextMenu } from "../context-menu.ts";
  import { conversationTitle, type ConversationView } from "../model.ts";
  import BotHome from "./BotHome.svelte";
  import { useBotHome } from "../home.svelte.ts";
  import MarkdownSnippet from "#lib/shared/ui/markdown/MarkdownSnippet.svelte";
  import ActionItems from "./ActionItems.svelte";

  /**
   * One conversation in the Bots list (shared by `BotListItem` and `GroupListItem`): avatar, name,
   * last message, time and unread count. The whole row links to the chat; its actions (pin, mark
   * as read) open from the "…" button that replaces the time on hover or focus, from a right click,
   * the Menu key or a long press.
   */
  let {
    conversation,
    href,
    current = false,
    avatar,
    class: className,
    ...handlers
  }: { conversation: ConversationView; href: string; current?: boolean; avatar: Snippet; class?: ClassValue } & ConversationHandlers = $props();

  let menuOpen = $state(false);
  const title = $derived(conversationTitle(conversation));
  const home = useBotHome(() => conversation.nodeId);
  const items = $derived(conversationMenu(conversation, home.reason ? {} : handlers));
  // Who wrote the last message, when that is not the 1:1 chat's own bot: "You: …", "Notes: …".
  const author = $derived.by(() => {
    const last = conversation.lastMessage;
    if (!last || last.failed || (conversation.kind === "direct" && last.senderId === conversation.bots[0]?.id)) return "";
    return last.senderId === "me" ? "You" : (conversation.bots.find((b) => b.id === last.senderId)?.name ?? "");
  });
</script>

<div
  class={[
    "group relative flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-zinc-950/4 has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-brand-500 dark:hover:bg-white/4",
    current && "bg-zinc-950/6 dark:bg-white/8",
    home.reason && "opacity-60",
    className,
  ]}
  {@attach contextMenu(() => (menuOpen = items.length > 0))}
>
  {@render avatar()}
  <div class="grid min-w-0 flex-1 grid-cols-1 gap-0.5">
    {#if conversation.nodeId}<BotHome nodeId={conversation.nodeId} />{/if}
    <p class="flex items-baseline gap-2">
      <a
        {href}
        aria-current={current ? "page" : undefined}
        class="min-w-0 flex-1 truncate text-base/6 font-medium text-zinc-900 after:absolute after:inset-0 after:rounded-xl focus:outline-none sm:text-sm/5 dark:text-zinc-100"
      >
        {title}
      </a>
      {#if conversation.lastMessage}
        <time
          datetime={conversation.lastMessage.at.toISOString()}
          class={["shrink-0 text-sm/5 text-zinc-500 tabular-nums sm:text-xs/5 dark:text-zinc-400", items.length > 0 && "pointer-fine:group-hover:invisible group-has-[button:focus-visible]:invisible group-has-aria-expanded:invisible"]}
        >
          {listTimeLabel(conversation.lastMessage.at, clock.now)}
        </time>
      {/if}
    </p>
    <p class="flex items-center gap-2">
      <span class={["min-w-0 flex-1 truncate text-sm/5", conversation.unread > 0 ? "text-zinc-700 dark:text-zinc-300" : "text-zinc-500 dark:text-zinc-400"]}>
        {#if !conversation.lastMessage}
          No messages yet
        {:else if conversation.lastMessage.failed}
          <span class="text-rose-600 dark:text-rose-400">Couldn't reply</span>
        {:else}
          {#if author}{`${author}: `}{/if}<MarkdownSnippet text={conversation.lastMessage.text} />
        {/if}
      </span>
      {#if conversation.unread > 0}
        <span class="shrink-0 rounded-full bg-brand-600 px-1.5 text-xs/5 font-medium text-white tabular-nums">
          {conversation.unread > 99 ? "99+" : conversation.unread}<span class="sr-only"> unread</span>
        </span>
      {/if}
    </p>
  </div>

  {#if items.length > 0}
    <DropdownMenu label="Actions for {title}" bind:open={menuOpen} placement="bottom-end">
      {#snippet trigger(props)}
        <span class="absolute top-1.5 right-1.5">
          <IconButton
            icon="ellipsis-horizontal"
            label="Actions for {title}"
            size="sm"
            {...props}
            class="opacity-0 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:pointer-events-none pointer-fine:group-hover:opacity-100"
          />
        </span>
      {/snippet}
      <ActionItems actions={items} />
    </DropdownMenu>
  {/if}
</div>

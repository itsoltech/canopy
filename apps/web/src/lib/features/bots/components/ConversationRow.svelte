<script lang="ts">
  import "#lib/features/navigation/sidebar-rows.css";
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { conversationMenu, type ConversationHandlers } from "../actions.ts";
  import { listTimeLabel } from "../chat-timeline.ts";
  import { contextMenu } from "../context-menu.ts";
  import { conversationTitle, type ConversationView } from "@canopy/domain/bot-chat";
  import { useBotHome } from "../home.svelte.ts";
  import MarkdownSnippet from "#lib/shared/ui/markdown/MarkdownSnippet.svelte";
  import ActionItems from "./ActionItems.svelte";
  import SidebarQuickArchive from "#lib/features/navigation/SidebarQuickArchive.svelte";
  import { focusAfterArchive } from "#lib/features/navigation/sidebar-focus.ts";

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
  }: {
    conversation: ConversationView;
    href: string;
    current?: boolean;
    avatar: Snippet;
    class?: ClassValue;
  } & ConversationHandlers = $props();

  let menuOpen = $state(false);
  let archiving = $state(false);
  let rowBox: HTMLElement | undefined = $state();
  const title = $derived(conversationTitle(conversation));
  const home = useBotHome(() => conversation.nodeId);
  const items = $derived(conversationMenu(conversation, home.reason ? {} : handlers));

  async function archive(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();

    if (archiving || home.reason || !handlers.onArchive) return;
    const focusNext = focusAfterArchive(rowBox);

    archiving = true;

    try {
      await handlers.onArchive(conversation);
      focusNext();
    } finally {
      archiving = false;
    }
  }

  // Who wrote the last message, when that is not the 1:1 chat's own bot: "You: …", "Notes: …".
  const author = $derived.by(() => {
    const last = conversation.lastMessage;

    if (!last || last.failed || (conversation.kind === "direct" && last.senderId === conversation.bots[0]?.id))
      return "";

    return last.senderId === "me" ? "You" : (conversation.bots.find((b) => b.id === last.senderId)?.name ?? "");
  });
</script>

<div
  bind:this={rowBox}
  data-actions-open={menuOpen || undefined}
  data-sidebar-archive-row={Boolean(handlers.onArchive) || undefined}
  class={[
    "sidebar-action-row sidebar-row sidebar-row-padding group relative flex min-h-12 items-center gap-3 rounded-xl py-2 has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-brand-500",
    current ? "bg-zinc-950/6 dark:bg-white/8" : "hover:bg-zinc-950/4 dark:hover:bg-white/4",
    home.reason && "opacity-60",
    className,
  ]}
  {@attach contextMenu(() => (menuOpen = items.length > 0))}
>
  <div class="sidebar-row-avatar shrink-0">{@render avatar()}</div>
  <div class="grid min-w-0 flex-1 grid-cols-1 gap-0.5">
    <p class="flex items-baseline gap-2">
      <a
        {href}
        aria-current={current ? "page" : undefined}
        class="min-w-0 flex-1 truncate text-base/5.5 font-medium text-zinc-900 after:absolute after:inset-0 after:rounded-xl focus:outline-none sm:text-sm/5 dark:text-zinc-100"
      >
        {title}
        {#if home.reason}<span class="sr-only left-0">Read-only. {home.reason}</span>{/if}
      </a>
      <span class={["w-16 shrink-0 text-right", items.length > 0 && "sidebar-swap-resting"]}>
        {#if conversation.lastMessage}<time
            datetime={conversation.lastMessage.at.toISOString()}
            class="block truncate text-sm/5 text-zinc-500 tabular-nums sm:text-xs/4.5 dark:text-zinc-400"
          >
            {listTimeLabel(conversation.lastMessage.at, clock.now)}
          </time>{/if}
      </span>
    </p>
    <p class="flex items-center gap-2">
      <span
        class={[
          "min-w-0 flex-1 truncate text-sm/5 sm:text-xs/4.5",
          conversation.unread > 0 ? "text-zinc-700 dark:text-zinc-300" : "text-zinc-500 dark:text-zinc-400",
        ]}
      >
        {#if !conversation.lastMessage}
          No messages yet
        {:else if conversation.lastMessage.failed}
          <span class="text-rose-600 dark:text-rose-400">Couldn't reply</span>
        {:else}
          {#if author}{`${author}: `}{/if}<MarkdownSnippet text={conversation.lastMessage.text} />
        {/if}
      </span>
      <span class={["flex w-7 shrink-0 justify-end", handlers.onArchive && !home.reason && "sidebar-swap-resting"]}>
        {#if conversation.unread > 0}<span
            class="shrink-0 rounded-full bg-action px-1.5 text-xs/4.5 font-medium text-on-accent tabular-nums"
          >
            {conversation.unread > 99 ? "99+" : conversation.unread}<span class="sr-only"> unread</span>
          </span>{/if}
      </span>
    </p>
  </div>

  {#if handlers.onArchive && !home.reason}
    <SidebarQuickArchive
      archived={conversation.archived ?? false}
      label="{conversation.archived ? 'Unarchive' : 'Archive'} bot {title}"
      loading={archiving}
      onclick={(event) => void archive(event)}
      class="right-(--sidebar-row-padding) bottom-[0.6875rem] sm:bottom-2.5"
    />
  {/if}

  {#if items.length > 0}
    <DropdownMenu label="Actions for {title}" bind:open={menuOpen} placement="bottom-end">
      {#snippet trigger(props)}
        <span
          class="sidebar-swap-action absolute top-1.5 right-[calc(var(--sidebar-row-padding)-(--spacing(1.5)))] pointer-coarse:hidden"
        >
          <IconButton icon="ellipsis-horizontal" label="Actions for {title}" size="sm" {...props} />
        </span>
      {/snippet}
      <ActionItems actions={items} />
    </DropdownMenu>
  {/if}
</div>

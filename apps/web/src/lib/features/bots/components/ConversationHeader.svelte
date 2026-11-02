<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { useShell } from "#lib/features/navigation/shell.ts";
  import SidebarToggle from "#lib/features/navigation/SidebarToggle.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { conversationTitle, type ConversationView } from "../model.ts";
  import AvatarStack from "./AvatarStack.svelte";
  import BotAvatar from "./BotAvatar.svelte";

  /**
   * Top bar of a bot chat with a centered pill: the bot (1:1), the group's avatars and name, or the
   * two bots with ⇄ between them (watched chat). The menu button opens the navigation on small
   * screens (the sidebar toggle shows and hides it on desktop); `actions` go on the right.
   */
  let { conversation, actions, statusLine = "", class: className }: { conversation: ConversationView; actions?: Snippet; statusLine?: string; class?: ClassValue } = $props();
  const shell = useShell();
  const title = $derived(conversationTitle(conversation));
</script>

<header class={["flex h-14 shrink-0 items-center gap-2 px-2 sm:px-4", className]}>
  <div class="flex flex-1 items-center">
    <IconButton icon="bars-3" label="Open menu" class="lg:hidden" onclick={() => shell.openMenu()} />
    <SidebarToggle />
  </div>
  <h1 class="min-w-0">
    <span class="flex min-w-0 items-center gap-2 rounded-full bg-zinc-950/5 py-1 pr-3.5 pl-1 text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:bg-white/8 dark:text-white">
      {#if conversation.kind === "watch" && conversation.bots.length === 2}
        <BotAvatar participant={conversation.bots[0]!} size="sm" />
        <span class="truncate">{conversation.bots[0]!.name}</span>
        <Icon name="arrows-right-left" class="fill-zinc-400 dark:fill-zinc-500" label="talking with" />
        <BotAvatar participant={conversation.bots[1]!} size="sm" />
        <span class="truncate">{conversation.bots[1]!.name}</span>
      {:else if conversation.kind === "direct" && conversation.bots[0]}
        <BotAvatar participant={conversation.bots[0]} size="sm" />
        <span class="truncate">{title}</span>
      {:else}
        <AvatarStack participants={conversation.bots} class="[--avatar-ring:var(--color-zinc-100)] dark:[--avatar-ring:var(--color-zinc-900)]" />
        <span class="truncate">{title}</span>
        <span class="shrink-0 text-zinc-500 tabular-nums dark:text-zinc-400">{conversation.bots.length + 1}</span>
        <span class="sr-only">participants</span>
      {/if}
    </span>
    {#if statusLine}<span role="status" class="block pt-0.5 text-center text-xs font-normal text-zinc-500 dark:text-zinc-400">{statusLine}</span>{/if}
  </h1>
  <div class="flex flex-1 items-center justify-end gap-1">
    {@render actions?.()}
  </div>
</header>

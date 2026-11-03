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
  import type { MascotState } from "../behaviour.ts";
  import { openBotSettings } from '../settings/open.ts';
  import TouchTarget from '#lib/shared/ui/TouchTarget.svelte';
  import { useBotHome } from '../home.svelte.ts';

  /**
   * Top bar of a bot chat, left-aligned like a messenger: the bot's avatar and name (1:1), the group's
   * avatars and name, or both bots with ⇄ between them (a bot ⇄ bot chat). `subtitle` is one quiet line
   * under the name (e.g. the model). What the bot is doing is not here: it shows under its last message.
   * The menu button opens the navigation on small screens; `actions` go on the right. `state` and `event`
   * drive the living mascots (what the bot is doing, a new message). As the page's top bar (`titlebar`) it is
   * a macOS window title strip in every sidebar state (routes/layout.css).
   */
  let { conversation, subtitle, actions, state = "idle", event, titlebar = true, class: className }: { conversation: ConversationView; subtitle?: string | undefined; actions?: Snippet; state?: MascotState; event?: unknown; titlebar?: boolean; class?: ClassValue } = $props();
  const shell = useShell();
  const title = $derived(conversationTitle(conversation));
  const home = useBotHome(() => conversation.nodeId);
</script>

<header class={["flex h-12 shrink-0 items-center gap-2 px-2 sm:px-4", className]} data-window-titlebar={titlebar || undefined}>
  <IconButton icon="bars-3" label="Open menu" class="lg:hidden" onclick={() => shell.openMenu()} />
  <SidebarToggle />
  <div class="flex min-w-0 flex-1 items-center gap-2.5 pl-1">
    {#if conversation.kind === "watch" && conversation.bots.length === 2}
      <span class="flex shrink-0 -space-x-1.5 [--avatar-ring:var(--color-white)] dark:[--avatar-ring:var(--color-black)]">
        <BotAvatar participant={conversation.bots[0]!} size="sm" {state} {event} class="rounded-full ring-2 ring-(--avatar-ring)" />
        <BotAvatar participant={conversation.bots[1]!} size="sm" {state} {event} class="rounded-full ring-2 ring-(--avatar-ring)" />
      </span>
    {:else if conversation.kind === "direct" && conversation.bots[0]}
      <button type="button" class="relative rounded-full focus-ring" disabled={Boolean(home.reason)} aria-label="Edit {title}" onclick={() => openBotSettings(conversation.id)}><BotAvatar participant={conversation.bots[0]} size="sm" {state} {event} /><TouchTarget /></button>
    {:else}
      <AvatarStack participants={conversation.bots} {state} {event} class="[--avatar-ring:var(--color-white)] dark:[--avatar-ring:var(--color-black)]" />
    {/if}
    <div class="min-w-0">
      <h1 class="flex min-w-0 items-center gap-1.5 text-base/5 font-semibold text-zinc-950 sm:text-sm/5 dark:text-white">
        {#if conversation.kind === "watch" && conversation.bots.length === 2}
          <span class="truncate">{conversation.bots[0]!.name}</span>
          <Icon name="arrows-right-left" class="shrink-0 fill-zinc-400 dark:fill-zinc-500" label="and" />
          <span class="truncate">{conversation.bots[1]!.name}</span>
        {:else}
          {#if conversation.kind === 'direct'}<button type="button" class="relative truncate rounded focus-ring" disabled={Boolean(home.reason)} aria-label="Edit {title}" onclick={() => openBotSettings(conversation.id)}>{title}<TouchTarget /></button>{:else}<span class="truncate">{title}</span>{/if}
          {#if conversation.kind === "group"}<span class="shrink-0 font-normal text-zinc-500 tabular-nums dark:text-zinc-400">{conversation.bots.length + 1}<span class="sr-only"> participants</span></span>{/if}
        {/if}
      </h1>
      {#if subtitle}<p class="truncate text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400">{subtitle}</p>{/if}
    </div>
  </div>
  <div class="flex shrink-0 items-center gap-1">
    {@render actions?.()}
  </div>
</header>

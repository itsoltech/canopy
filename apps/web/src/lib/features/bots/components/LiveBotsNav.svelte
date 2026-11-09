<script lang="ts">
  import { page } from "$app/state";
  import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { botList } from "../bot-list.svelte.ts";
  import { botConversation } from "../live.ts";
  import BotsNav from "./BotsNav.svelte";
  import BotsSectionEmpty from "./BotsSectionEmpty.svelte";
  import { openBotSettings } from "../settings/open.ts";
  import { archiveBot, reportLifecycleError } from "../settings/lifecycle.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { ConversationView } from "@canopy/domain/bot-chat";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";

  /** The Bots section of the sidebar with your real bots (pinned first), or the way to create the first one. */
  let { query = "" }: { query?: string } = $props();
  const settings = useSettings();
  const capabilities = useGatewayCapabilities();

  const conversations = $derived(
    botList.list.filter((b) => !b.archived).map((b) => botConversation(b, settings.sidebar.pinnedBotIds)),
  );

  const archived = $derived(botList.list.filter((b) => b.archived).map((b) => botConversation(b)));

  async function archive(c: ConversationView) {
    const bot = botList.list.find((b) => b.id === c.id);

    if (!bot) return;

    try {
      await archiveBot(bot, !bot.archived);

      if (!bot.archived) await settings.pinBot(bot.id, false);
    } catch (cause) {
      reportLifecycleError(cause);
    }
  }

  const move = (c: ConversationView) => window.dispatchEvent(new CustomEvent("move-bot", { detail: c.id }));

  $effect(() => botList.use());
</script>

{#if botList.error}<p role="alert" class="px-3 py-2 text-sm/6 text-rose-600 dark:text-rose-400">{botList.error}</p>{/if}
{#if conversations.length}
  <BotsNav
    {conversations}
    {query}
    currentId={page.params.botId}
    hrefOf={(c) => `/bots/${c.id}`}
    onEdit={(c) => openBotSettings(c.id)}
    onArchive={archive}
    onMove={capabilities?.linkedComputers ? move : undefined}
    onTogglePin={(c) => {
      void settings.pinBot(c.id, !c.pinned);
    }}
  />
{:else if botList.loaded && !botList.error}<BotsSectionEmpty {query} />{/if}
{#if archived.length}
  <details
    class="group pt-4"
    open={devicePreferences.view.archivedBotsExpanded}
    ontoggle={(event) => {
      if (event.currentTarget.open !== devicePreferences.view.archivedBotsExpanded)
        devicePreferences.setView({ archivedBotsExpanded: event.currentTarget.open });
    }}
  >
    <summary
      class="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-sm text-zinc-500 focus-ring dark:text-zinc-400"
      ><Icon name="chevron-right" class="group-open:rotate-90" />Archived bots · {archived.length}</summary
    >
    <BotsNav
      conversations={archived}
      {query}
      currentId={page.params.botId}
      hrefOf={(c) => `/bots/${c.id}`}
      onEdit={(c) => openBotSettings(c.id)}
      onArchive={archive}
      onMove={capabilities?.linkedComputers ? move : undefined}
      onDelete={(c) => window.dispatchEvent(new CustomEvent("delete-bot", { detail: c.id }))}
    />
  </details>
{/if}

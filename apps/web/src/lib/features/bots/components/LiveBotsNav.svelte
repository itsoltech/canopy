<script lang="ts">
  import { page } from "$app/state";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { botList } from "../bot-list.svelte.ts";
  import { botConversation } from "../live.ts";
  import BotsNav from "./BotsNav.svelte";
  import BotsSectionEmpty from "./BotsSectionEmpty.svelte";

  /** The Bots section of the sidebar with your real bots (pinned first), or the way to create the first one. */
  let { query = "" }: { query?: string } = $props();
  const settings = useSettings();
  const conversations = $derived(botList.list.map((b) => botConversation(b, settings.sidebar.pinnedBotIds)));
  $effect(() => botList.use());
</script>

{#if botList.error}<p role="alert" class="px-3 py-2 text-sm/6 text-rose-600 dark:text-rose-400">{botList.error}</p>{/if}
{#if botList.list.length}
  <BotsNav {conversations} {query} currentId={page.params.botId} hrefOf={(c) => `/bots/${c.id}`} onTogglePin={(c) => { void settings.pinBot(c.id, !c.pinned); }} />
{:else if botList.loaded && !botList.error}<BotsSectionEmpty {query} />{/if}

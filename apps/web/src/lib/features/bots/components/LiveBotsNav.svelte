<script lang="ts">
  import { bots } from "@open-agents/contracts";
  import { page } from "$app/state";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import { botConversation } from "../live.ts";
  import BotsNav from "./BotsNav.svelte";
  import BotsSectionEmpty from "./BotsSectionEmpty.svelte";
  let { query = "" }: { query?: string } = $props();
  const settings = useSettings();
  let list = $state.raw<bots.Bot[]>([]);
  let error = $state("");
  const conversations = $derived(list.map((b) => botConversation(b, settings.sidebar.pinnedBotIds)));
  $effect(() => {
    let closed = false;
    const refresh = async () => {
      try {
        const response = decode(bots.ListBotsResponseSchema, await requestJson("GET", "/api/bots"));
        if (!closed) { list = response.bots; error = ""; }
      } catch { if (!closed) error = "Could not load bots"; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5000);
    window.addEventListener("bots-changed", refresh);
    return () => { closed = true; clearInterval(timer); window.removeEventListener("bots-changed", refresh); };
  });
</script>

{#if error}<p role="alert" class="px-3 py-2 text-sm text-red-500">{error}</p>{/if}
{#if list.length}
  <BotsNav {conversations} {query} currentId={page.params.botId} hrefOf={(c) => `/bots/${c.id}`} onTogglePin={(c) => { void settings.pinBot(c.id, !c.pinned); }} />
{:else if !error}<BotsSectionEmpty {query} />{/if}

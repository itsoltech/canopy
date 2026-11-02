<script lang="ts">
  import { bots } from "@open-agents/contracts";
  import { create } from "@bufbuild/protobuf";
  import ChatView from "#lib/features/bots/components/ChatView.svelte";
  import { botConversation, botEntries } from "#lib/features/bots/live.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { requestJson } from "#lib/shared/http.ts";
  import { liveSource } from "#lib/shared/live-source.ts";
  import { decode, encode } from "#lib/shared/wire.ts";
  import type { PageProps } from "./$types";
  let { data }: PageProps = $props();
  const settings = useSettings();
  let snapshot = $state.raw(create(bots.BotConversationSchema));
  let error = $state("");
  let sending = $state(false);
  let answering = $state<Record<string, string>>({});
  let retry = $state<{ text: string; clientRequestId: string }>();
  const conversation = $derived(botConversation(snapshot.bot ?? data.bot, settings.sidebar.pinnedBotIds));
  const entries = $derived(botEntries(snapshot));
  $effect(() => {
    const id = data.bot.id;
    snapshot = create(bots.BotConversationSchema, { bot: data.bot });
    retry = undefined;
    return liveSource(`/api/bots/${id}/events`, {
      onmessage: (json) => { snapshot = decode(bots.BotConversationSchema, JSON.parse(json)); error = ""; },
      onfailure: () => { error = "Connection interrupted. Reconnecting…"; },
    });
  });
  async function send(text: string) {
    const request = retry?.text === text ? retry : { text, clientRequestId: crypto.randomUUID() };
    sending = true;
    try { await requestJson("POST", `/api/bots/${data.bot.id}/messages`, request); retry = undefined; error = ""; }
    catch (cause) { retry = request; error = cause instanceof Error ? cause.message : "Could not send your message"; }
    finally { sending = false; }
  }
  async function answer(id: string, option: string) {
    answering = { ...answering, [id]: option };
    try {
      await requestJson("POST", `/api/bot-approvals/${id}`, encode(bots.AnswerBotApprovalRequestSchema, create(bots.AnswerBotApprovalRequestSchema, {
        approvalId: id, approve: option !== "discard", answer: option.startsWith("text:") ? option.slice(5) : "",
      })));
    } catch (cause) { error = cause instanceof Error ? cause.message : "Could not answer"; }
    finally { const next = { ...answering }; delete next[id]; answering = next; }
  }
  async function interrupt() {
    try { await requestJson("POST", `/api/bots/${data.bot.id}/interrupt`, {}); }
    catch { error = "Could not interrupt the bot"; }
  }
</script>

<svelte:head><title>{data.bot.configuration?.name ?? "Bot"} · Open Agents</title></svelte:head>
<div class="flex h-full min-h-0 flex-col">
  {#if error}<div role="alert" class="flex items-center justify-center gap-3 px-4 py-2 text-sm text-red-500">{error}{#if retry}<button class="underline" onclick={() => retry && send(retry.text)}>Retry message</button>{/if}</div>{/if}
  {#key data.bot.id}<ChatView {conversation} {entries} me={{ id: "me", kind: "user", name: "You" }} {sending} {answering} statusLine={snapshot.statusLine} onsend={send} onanswer={answer} class="flex-1">
    {#snippet actions()}{#if snapshot.working}<button onclick={interrupt} class="rounded-lg px-3 py-1 text-sm text-zinc-500 hover:bg-zinc-500/10">Stop</button>{/if}{/snippet}
  </ChatView>{/key}
</div>

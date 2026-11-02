<script lang="ts">
  import { bots, Provider, ui } from "@open-agents/contracts";
  import { create } from "@bufbuild/protobuf";
  import { modelDisplayName } from "#lib/features/models/catalog.ts";
  import { useModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import { instanceKeyOf } from "#lib/features/providers/instances.ts";
  import { botList } from "#lib/features/bots/bot-list.svelte.ts";
  import type { ApprovalAnswer, ApprovalPolicy } from "#lib/features/bots/components/ApprovalCard.svelte";
  import ChatView from "#lib/features/bots/components/ChatView.svelte";
  import { botConversation, botEntries, botParticipant, botWizardInstances } from "#lib/features/bots/live.ts";
  import type { ChatEntry } from "#lib/features/bots/model.ts";
  import ChangeModelDialog, { type BotModelChoice } from "#lib/features/bots/wizard/ChangeModelDialog.svelte";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { requestJson } from "#lib/shared/http.ts";
  import { liveSource } from "#lib/shared/live-source.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import { decode, encode } from "#lib/shared/wire.ts";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
  const settings = useSettings();
  const catalogs = useModelCatalog();
  let snapshot = $state.raw(create(bots.BotConversationSchema));
  let connection = $state("");
  let sending = $state(false);
  let retrying = $state(false);
  let answering = $state<Record<string, string>>({});
  /** Your messages until the conversation has them; a failed one keeps its request id for Retry. */
  let pending = $state<{ id: string; text: string; at: Date; baseline: number; failed: boolean }[]>([]);
  let instances = $state.raw<ui.ProviderInstance[]>([]);
  let changingModel = $state(false);

  const bot = $derived(snapshot.bot ?? data.bot);
  const config = $derived(bot.configuration ?? create(bots.BotConfigurationSchema));
  const conversation = $derived(botConversation(bot, settings.sidebar.pinnedBotIds));
  const directory = $derived(botList.list.filter((b) => b.id !== bot.id).map(botParticipant));
  const yours = $derived(snapshot.messages.filter((m) => m.senderId === "user"));
  const visiblePending = $derived(pending.filter((p) => !yours.slice(p.baseline).some((m) => m.text === p.text)));
  const entries = $derived<ChatEntry[]>([
    ...botEntries(snapshot),
    ...visiblePending.map((p): ChatEntry => ({ kind: "message", message: { id: p.id, senderId: "me", at: p.at, text: p.text, delivery: p.failed ? "failed" : "sending" } })),
  ]);
  const waiting = $derived(snapshot.approvals.some((a) => a.status === "pending"));
  const status = $derived(
    snapshot.working ? { bot: botParticipant(bot), text: snapshot.statusLine || (waiting ? "Waiting for you" : "Typing…"), waiting } : undefined,
  );
  const policy = $derived<ApprovalPolicy>(config.approvalPolicy === "always" ? "always" : "safe");
  const modelInstances = $derived(botWizardInstances(instances, [...catalogs.workers.values()]));

  $effect(() => botList.use());
  $effect(() => {
    const id = data.bot.id;
    snapshot = create(bots.BotConversationSchema, { bot: data.bot });
    pending = [];
    return liveSource(`/api/bots/${id}/events`, {
      onmessage: (json) => {
        snapshot = decode(bots.BotConversationSchema, JSON.parse(json));
        connection = "";
      },
      onfailure: () => (connection = "Connection interrupted. Reconnecting…"),
    });
  });

  async function deliver(item: { id: string; text: string }) {
    sending = true;
    try {
      await requestJson("POST", `/api/bots/${data.bot.id}/messages`, { text: item.text, clientRequestId: item.id });
    } catch {
      pending = pending.map((p) => (p.id === item.id ? { ...p, failed: true } : p));
    } finally {
      sending = false;
    }
  }
  function send(text: string) {
    const item = { id: crypto.randomUUID(), text, at: new Date(), baseline: yours.length, failed: false };
    pending = [...pending, item];
    void deliver(item);
  }
  function resend() {
    const failed = pending.find((p) => p.failed);
    if (!failed) return;
    pending = pending.map((p) => (p === failed ? { ...p, failed: false } : p));
    void deliver(failed);
  }

  async function reply(id: string, body: { approve: boolean; answer: string }, mark: string) {
    answering = { ...answering, [id]: mark };
    try {
      await requestJson("POST", `/api/bot-approvals/${id}`, encode(bots.AnswerBotApprovalRequestSchema, create(bots.AnswerBotApprovalRequestSchema, { approvalId: id, ...body })));
    } catch (cause) {
      connection = cause instanceof Error ? cause.message : "Could not send your answer";
    } finally {
      const { [id]: _, ...rest } = answering;
      answering = rest;
    }
  }
  function answer(id: string, option: string) {
    const question = snapshot.approvals.find((a) => a.id === id);
    if (option === "discard") return reply(id, { approve: false, answer: "" }, option);
    const text = option.startsWith("text:") ? option.slice(5) : (question?.options[Number(option.replace("option:", ""))] ?? "");
    return reply(id, { approve: true, answer: text }, option);
  }
  function approve(id: string, choice: ApprovalAnswer) {
    if (choice.approve) return reply(id, { approve: true, answer: "" }, "approve");
    return reply(id, { approve: false, answer: choice.edited ?? "" }, choice.edited ? "edit" : "discard");
  }

  async function save(configuration: bots.BotConfiguration) {
    const response = decode(bots.GetBotResponseSchema, await requestJson("PUT", `/api/bots/${data.bot.id}`, encode(bots.UpdateBotRequestSchema, create(bots.UpdateBotRequestSchema, { botId: data.bot.id, configuration }))));
    if (response.bot) snapshot = create(bots.BotConversationSchema, { ...snapshot, bot: response.bot });
    window.dispatchEvent(new Event("bots-changed"));
  }
  async function setPolicy(next: ApprovalPolicy) {
    try { await save(create(bots.BotConfigurationSchema, { ...config, approvalPolicy: next })); }
    catch { connection = "Could not change when this bot asks"; }
  }
  async function changeModel(choice: BotModelChoice) {
    const instance = instances.find((i) => instanceKeyOf(i) === choice.providerInstanceId);
    if (!instance) throw new Error("This provider instance is no longer available");
    await save(create(bots.BotConfigurationSchema, { ...config, provider: instance.harness, providerInstance: instance.id, model: choice.model, effort: choice.effort ?? "" }));
  }
  async function openChangeModel() {
    try {
      instances = decode(ui.ListProviderInstancesResponseSchema, await requestJson("GET", "/api/providers")).instances;
      changingModel = true;
    } catch {
      connection = "Could not load your provider instances";
    }
  }
  async function retry() {
    retrying = true;
    try { await requestJson("POST", `/api/bots/${data.bot.id}/retry`, {}); }
    catch (cause) { connection = cause instanceof Error ? cause.message : "Could not retry"; }
    finally { retrying = false; }
  }
  async function interrupt() {
    try { await requestJson("POST", `/api/bots/${data.bot.id}/interrupt`, {}); }
    catch { connection = "Could not stop the bot"; }
  }
</script>

<svelte:head><title>{config.name || "Bot"} · Open Agents</title></svelte:head>
<div class="flex h-full min-h-0 flex-col">
  {#key data.bot.id}
    <ChatView
      {conversation}
      {entries}
      me={{ id: "me", kind: "user", name: "You" }}
      {directory}
      subtitle={config.model ? `${modelDisplayName(config.model)}${config.provider === Provider.CODEX ? " · Codex" : " · Claude"}` : undefined}
      {status}
      {sending}
      {answering}
      {retrying}
      {policy}
      exchangeHref={(segment) => `/bots/${data.bot.id}/exchanges/${segment.exchangeId}`}
      onsend={send}
      onanswer={answer}
      onapprove={approve}
      onpolicy={setPolicy}
      onretry={retry}
      onchangemodel={openChangeModel}
      class="flex-1"
    >
      {#snippet actions()}
        {#if snapshot.working}<Button size="sm" variant="ghost" icon="stop" onclick={interrupt}>Stop</Button>{/if}
      {/snippet}
    </ChatView>
  {/key}
  {#if connection || pending.some((p) => p.failed)}
    <div role="alert" class="flex items-center justify-center gap-3 border-t border-zinc-950/5 px-4 py-2 text-sm/5 text-rose-600 dark:border-white/5 dark:text-rose-400">
      {connection || "Your message was not sent."}
      {#if pending.some((p) => p.failed)}<Button size="sm" variant="ghost" onclick={resend}>Send again</Button>{/if}
    </div>
  {/if}
</div>
<ChangeModelDialog
  bind:open={changingModel}
  botName={config.name}
  instances={modelInstances}
  initial={{ providerInstanceId: instanceKeyOf({ harness: config.provider, id: config.providerInstance }), model: config.model, effort: config.effort || undefined }}
  onsave={changeModel}
/>

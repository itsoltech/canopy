<script lang="ts">
  import { goto } from "$app/navigation";
  import { bots, Provider, ui, type Mention } from "@canopy/contracts";
  import { mentionsToWire } from "#lib/features/mentions/wire.ts";
  import { create } from "@bufbuild/protobuf";
  import { modelDisplayName } from "#lib/features/models/catalog.ts";
  import { useModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import { instanceKeyOf } from "#lib/features/providers/instances.ts";
  import { botList } from "#lib/features/bots/bot-list.svelte.ts";
  import type { ApprovalAnswer, ApprovalPolicy } from "#lib/features/bots/components/ApprovalCard.svelte";
  import ChatView from "#lib/features/bots/components/ChatView.svelte";
  import BotDetailsLayout from "#lib/features/bots/details/BotDetailsLayout.svelte";
  import BotDetailsPanel from "#lib/features/bots/details/BotDetailsPanel.svelte";
  import { botConversation, botEntries, botParticipant, botWizardInstances } from "#lib/features/bots/live.ts";
  import type { ChatEntry } from "#lib/features/bots/model.ts";
  import ChangeModelDialog, { type BotModelChoice } from "#lib/features/bots/wizard/ChangeModelDialog.svelte";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { requestJson } from "#lib/shared/http.ts";
  import { liveSource } from "#lib/shared/live-source.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import DropdownMenu from '#lib/shared/ui/DropdownMenu.svelte';
  import IconButton from '#lib/shared/ui/IconButton.svelte';
  import MenuItem from '#lib/shared/ui/MenuItem.svelte';
  import { openBotSettings } from '#lib/features/bots/settings/open.ts';
  import { archiveBot, reportLifecycleError } from '#lib/features/bots/settings/lifecycle.ts';
  import { decode, encode } from "#lib/shared/wire.ts";
  import type { PageProps } from "./$types";
  import BotHome from "#lib/features/bots/components/BotHome.svelte";
  import { useBotHome } from "#lib/features/bots/home.svelte.ts";
  import { nodeRef, splitId } from "@canopy/domain/computers";

  let { data }: PageProps = $props();
  const settings = useSettings();
  const catalogs = useModelCatalog();
  let snapshot = $state.raw(create(bots.BotConversationSchema));
  let connection = $state("");
  let sending = $state(false);
  let retrying = $state(false);
  let answering = $state<Record<string, string>>({});
  /** Your messages until the conversation has them; a failed one keeps its request id for Retry. */
  let pending = $state<{ id: string; text: string; mentions: Mention[]; quotes: ui.Quote[]; at: Date; baseline: number; failed: boolean }[]>([]);
  let instances = $state.raw<ui.ProviderInstance[]>([]);
  let changingModel = $state(false);
  let detailsOpen = $state(true);
  let detailsLayout = $state<ReturnType<typeof BotDetailsLayout>>();
  let detailsToggle: HTMLButtonElement | undefined;
  function closeDetails() { detailsLayout?.close(); detailsToggle?.focus(); }
  let observedBotId: string | undefined;

  const bot = $derived(botList.list.find((b) => b.id === data.bot.id) ?? snapshot.bot ?? data.bot);
  const home = useBotHome(() => bot.nodeId);
  const canAct = $derived(!bot.archived && !home.reason);
  const config = $derived(bot.configuration ?? create(bots.BotConfigurationSchema));
  const conversation = $derived(botConversation(bot, settings.sidebar.pinnedBotIds));
  const directory = $derived(botList.list.filter((b) => b.id !== bot.id).map(botParticipant));
  const yours = $derived(snapshot.messages.filter((m) => m.senderId === "user"));
  const visiblePending = $derived(pending.filter((p) => !yours.slice(p.baseline).some((m) => m.text === p.text
    && JSON.stringify(m.quotes.map((q) => encode(ui.QuoteSchema, q))) === JSON.stringify(p.quotes.map((q) => encode(ui.QuoteSchema, q)))
    && m.mentions.length === p.mentions.length && m.mentions.every((mention, index) => mention.name === p.mentions[index]?.name && mention.start === p.mentions[index]?.start && mention.end === p.mentions[index]?.end))));
  const entries = $derived<ChatEntry[]>([
    ...botEntries(snapshot),
    ...visiblePending.map((p): ChatEntry => ({ kind: "message", message: { id: p.id, senderId: "me", at: p.at, text: p.text, mentions: p.mentions, quotes: p.quotes, delivery: p.failed ? "failed" : "sending" } })),
  ]);
  const waiting = $derived(snapshot.approvals.some((a) => a.status === "pending"));
  const status = $derived(
    snapshot.working ? { bot: botParticipant(bot), text: snapshot.statusLine || (waiting ? "Waiting for you" : "Typing…"), waiting } : undefined,
  );
  const policy = $derived<ApprovalPolicy>(config.approvalPolicy === "always" || config.approvalPolicy === "full_auto" ? config.approvalPolicy : "safe");
  const modelInstances = $derived(botWizardInstances(instances, [...catalogs.workers.values()].filter((w) => splitId(w.workerId).node === (bot.nodeId ? nodeRef(bot.nodeId) : undefined))));

  $effect(() => botList.use());
  function markVisibleRead() {
    const last = snapshot.messages.at(-1)?.seq;
    if (!home.reason && snapshot.bot && last && last > snapshot.bot.lastReadSeq && document.visibilityState === 'visible') {
      void botList.markRead(snapshot.bot.id, last).catch(() => undefined);
    }
  }
  $effect(() => { markVisibleRead(); });
  $effect(() => {
    document.addEventListener('visibilitychange', markVisibleRead);
    return () => document.removeEventListener('visibilitychange', markVisibleRead);
  });
  $effect(() => {
    const id = data.bot.id;
    if (botList.list.some((b) => b.id === id)) observedBotId = id;
    else if (observedBotId === id && botList.loaded && !botList.error) void goto('/bots');
  });
  $effect(() => {
    const id = data.bot.id;
    snapshot = create(bots.BotConversationSchema, { bot: data.bot });
    pending = [];
    return liveSource(`/api/bots/${id}/events`, {
      onmessage: (json) => {
        snapshot = decode(bots.BotConversationSchema, JSON.parse(json));
        if (snapshot.bot) botList.upsert(snapshot.bot);
        connection = "";
      },
      onfailure: () => (connection = "Connection interrupted. Reconnecting…"),
    });
  });

  async function deliver(item: { id: string; text: string; mentions: Mention[]; quotes: ui.Quote[] }) {
    sending = true;
    try {
      await requestJson("POST", `/api/bots/${data.bot.id}/messages`, { text: item.text, mentions: mentionsToWire(item.mentions), quotes: item.quotes.map((q) => encode(ui.QuoteSchema, q)), clientRequestId: item.id });
    } catch {
      pending = pending.map((p) => (p.id === item.id ? { ...p, failed: true } : p));
    } finally {
      sending = false;
    }
  }
  function send(text: string, mentions: Mention[], quotes: ui.Quote[]) {
    if (!canAct) return;
    const item = { id: crypto.randomUUID(), text, mentions, quotes, at: new Date(), baseline: yours.length, failed: false };
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
    if (!canAct) return;
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
    await botList.save(bot, configuration);
  }
  async function setPolicy(next: ApprovalPolicy) {
    try { await save(create(bots.BotConfigurationSchema, { ...config, approvalPolicy: next })); }
    catch { connection = "Could not change when this bot asks"; return; }
    // Switching to full auto from a card means "stop asking": the actions already waiting go ahead too.
    if (next === "full_auto") for (const a of snapshot.approvals) if (a.status === "pending" && a.kind === "approval") approve(a.id, { approve: true });
  }
  async function changeModel(choice: BotModelChoice) {
    const instance = instances.find((i) => instanceKeyOf(i) === choice.providerInstanceId);
    if (!instance) throw new Error("This provider instance is no longer available");
    await save(create(bots.BotConfigurationSchema, { ...config, provider: instance.harness, providerInstance: instance.id, model: choice.model, effort: choice.effort ?? "" }));
  }
  async function openChangeModel() {
    try {
      instances = decode(ui.ListProviderInstancesResponseSchema, await requestJson("GET", `/api/bots/${bot.id}/providers`)).instances;
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

<svelte:head><title>{config.name || "Bot"} · Canopy</title></svelte:head>
<div class="flex h-full min-h-0 flex-col">
  <BotHome nodeId={bot.nodeId} banner class="px-4 py-2 sm:px-6" />
  {#key data.bot.id}
    <BotDetailsLayout bind:this={detailsLayout} bind:open={detailsOpen} ownerId={bot.ownerUserId}>
      {#snippet panel()}<BotDetailsPanel {bot} routines={snapshot.routines} reminders={snapshot.reminders} status={snapshot.statusLine} onclose={closeDetails} />{/snippet}
    <ChatView
      {conversation}
      {entries}
      me={{ id: "me", kind: "user", name: "You" }}
      {directory}
      subtitle={config.model ? `${modelDisplayName(config.model)}${config.provider === Provider.CODEX ? " · Codex" : config.provider === Provider.GROK ? " · Grok" : " · Claude"}` : undefined}
      {status}
      {sending}
      {answering}
      {retrying}
      {policy}
      composerDisabledReason={home.reason}
      onanswer={canAct ? answer : undefined}
      onapprove={canAct ? approve : undefined}
      onpolicy={canAct ? setPolicy : undefined}
      exchangeHref={(segment) => `/bots/${data.bot.id}/exchanges/${segment.exchangeId}`}
      onsend={send}
      onretry={canAct ? retry : undefined}
      onchangemodel={canAct ? openChangeModel : undefined}
      class="flex-1"
    >
      {#snippet actions()}
        {#if snapshot.working}<Button size="sm" variant="ghost" icon="stop" disabled={!canAct} onclick={interrupt}>Stop</Button>{/if}
        <IconButton icon="information-circle" label="Bot details" aria-expanded={detailsLayout?.isExpanded() ?? false} onclick={(event) => { detailsToggle = event.currentTarget; detailsLayout?.toggle(); }} />
        <DropdownMenu label="Bot actions" placement="bottom-end">
          {#snippet trigger(props)}<IconButton icon="ellipsis-horizontal" label="Bot actions" {...props} />{/snippet}
          <MenuItem icon="pencil-square" disabled={Boolean(home.reason)} onselect={() => openBotSettings(bot.id)}>Edit bot…</MenuItem>
          {#if !bot.archived}<MenuItem icon="star" onselect={() => { void settings.pinBot(bot.id, !conversation.pinned); }}>{conversation.pinned ? 'Unpin' : 'Pin to top'}</MenuItem>{/if}
          <MenuItem icon="archive-box" disabled={Boolean(home.reason)} onselect={() => { void archiveBot(bot, !bot.archived).then(() => settings.pinBot(bot.id, false)).catch(reportLifecycleError); }}>{bot.archived ? 'Unarchive bot' : 'Archive bot'}</MenuItem>
          {#if bot.archived}<MenuItem icon="trash" disabled={Boolean(home.reason)} onselect={() => window.dispatchEvent(new CustomEvent('delete-bot', { detail: bot.id }))}>Delete bot…</MenuItem>{/if}
        </DropdownMenu>
      {/snippet}
      {#snippet archived()}
        {#if bot.archived}<div class="flex flex-wrap items-center justify-center gap-3 rounded-xl bg-zinc-950/3 p-4 text-base/6 sm:text-sm/6 dark:bg-white/4"><p class="text-zinc-500 dark:text-zinc-400">{config.name} is archived</p><Button onclick={() => { void archiveBot(bot, false).catch(reportLifecycleError); }}>Unarchive</Button></div>{/if}
      {/snippet}
    </ChatView>
    </BotDetailsLayout>
  {/key}
  {#if connection || pending.some((p) => p.failed)}
    <div role="alert" class="flex items-center justify-center gap-3 border-t border-zinc-950/5 px-4 py-2 text-sm/5 text-rose-600 dark:border-white/5 dark:text-rose-400">
      {connection || "Your message was not sent."}
      {#if !bot.archived && pending.some((p) => p.failed)}<Button size="sm" variant="ghost" onclick={resend}>Send again</Button>{/if}
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

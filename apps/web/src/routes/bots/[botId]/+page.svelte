<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import { tick } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import BotApprovalRules from "#lib/features/bots/settings/BotApprovalRules.svelte";
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
  import { learnFromConversation, type ChatEntry } from "@canopy/domain/bot-chat";
  import ChangeModelDialog, { type BotModelChoice } from "#lib/features/bots/wizard/ChangeModelDialog.svelte";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { botComposerDraft } from "#lib/features/bots/composer-draft.svelte.ts";
  import { limitsOf } from "#lib/features/attachments/draft.svelte.ts";
  import { requestJson } from "#lib/shared/http.ts";
  import { watchBot } from "#lib/features/bots/watch.svelte.ts";
  import { canAnswerBotApproval } from "@canopy/domain/bot-snapshot";
  import Button from "#lib/shared/ui/Button.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import { openBotDeletion, openBotSettings } from "#lib/features/bots/settings/open.ts";
  import { archiveBot, reportLifecycleError } from "#lib/features/bots/settings/lifecycle.ts";
  import { decode, encode } from "#lib/shared/wire.ts";
  import type { PageProps } from "./$types";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { useBotHome } from "#lib/features/bots/home.svelte.ts";
  import MovedBotNotice from "#lib/features/bots/components/MovedBotNotice.svelte";
  import { nodeRef, splitId } from "@canopy/domain/computers";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import { rememberOpenedBot } from "#lib/features/bots/last-opened.ts";

  let { data }: PageProps = $props();
  const settings = useSettings();
  const composerDraft = $derived(botComposerDraft(data.bot.id, () => limitsOf(settings.attachmentLimits)));
  const scopeId = $derived(data.bot.id);
  const lifetime = $derived({ botId: scopeId, active: true });
  const capabilities = useGatewayCapabilities();
  const catalogs = useModelCatalog();
  const history = watchBot(() => data.bot.id);
  const emptySnapshot = create(bots.BotConversationSchema);

  $effect(() => {
    const scope = capabilities?.clientPreferencesScope;

    if (scope) rememberOpenedBot(scope, data.bot.id);
  });

  let snapshot = $derived.by(() => {
    const current = history.snapshot ?? emptySnapshot;

    if (settings.moduleEnabled("threads")) return current;

    return { ...current, approvals: current.approvals.filter((a) => !a.threadId || a.status !== "pending") };
  });

  const reactionError = "Could not save the reaction. Try again.";
  let connection = $state("");
  const expiredNotice = $derived(connection === "This request expired. No answer was sent.");
  let sending = $state(false);
  let retrying = $state(false);
  let stopping = $state(false);
  let answering = $state<Record<string, string>>({});
  let ruleDialog = $state(false);

  $effect(() => {
    ruleDialog = !!page.url.searchParams.get("rule");
  });

  /** Your messages until the conversation has them; a failed one keeps its request id for Retry. */
  let pending = $state<
    {
      id: string;
      text: string;
      mentions: Mention[];
      quotes: ui.Quote[];
      attachments: ui.Attachment[];
      revision: bigint | undefined;
      at: Date;
      baseline: number;
      failed: boolean;
    }[]
  >([]);

  let instances = $state.raw<ui.ProviderInstance[]>([]);
  let changingModel = $state(false);
  let detailsOpen = $state(true);
  let detailsLayout = $state<ReturnType<typeof BotDetailsLayout>>();
  let chatView = $state<ReturnType<typeof ChatView>>();
  let detailsToggle: HTMLButtonElement | undefined;

  function closeDetails() {
    detailsLayout?.close();
    detailsToggle?.focus();
  }

  function learn() {
    const { prompt } = learnFromConversation;

    if (!composerDraft.text.endsWith(prompt)) {
      composerDraft.text += composerDraft.text ? `\n\n${prompt}` : prompt;
    }

    void tick().then(() => chatView?.focusComposer());
  }

  let observedBotId: string | undefined;

  const listedBot = $derived(botList.list.find((b) => b.id === data.bot.id));
  const bot = $derived(listedBot ?? snapshot.bot ?? data.bot);
  const home = useBotHome(() => bot.nodeId);
  const canAct = $derived(history.live && !bot.archived && !home.reason);
  const config = $derived(bot.configuration ?? create(bots.BotConfigurationSchema));
  const conversation = $derived(botConversation(bot, settings.sidebar.pinnedBotIds));
  const directory = $derived(botList.list.filter((b) => b.id !== bot.id).map(botParticipant));
  const yours = $derived(snapshot.messages.filter((m) => m.senderId === "user"));

  const visiblePending = $derived(
    pending.filter(
      (p) =>
        !yours
          .slice(p.baseline)
          .some(
            (m) =>
              m.text === p.text &&
              m.attachments.map((a) => a.id).join() === p.attachments.map((a) => a.id).join() &&
              JSON.stringify(m.quotes.map((q) => encode(ui.QuoteSchema, q))) ===
                JSON.stringify(p.quotes.map((q) => encode(ui.QuoteSchema, q))) &&
              m.mentions.length === p.mentions.length &&
              m.mentions.every(
                (mention, index) =>
                  mention.name === p.mentions[index]?.name &&
                  mention.start === p.mentions[index]?.start &&
                  mention.end === p.mentions[index]?.end,
              ),
          ),
    ),
  );

  const entries = $derived<ChatEntry[]>([
    ...botEntries(snapshot),
    ...visiblePending.map((p): ChatEntry => ({
      kind: "message",
      message: {
        id: p.id,
        senderId: "me",
        at: p.at,
        text: p.text,
        mentions: p.mentions,
        quotes: p.quotes,
        attachments: p.attachments,
        delivery: p.failed ? "failed" : "sending",
      },
    })),
  ]);

  const waiting = $derived(snapshot.approvals.some((a) => a.status === "pending"));

  const status = $derived(
    snapshot.working || snapshot.statusLine
      ? { bot: botParticipant(bot), text: snapshot.statusLine || (waiting ? "Waiting for you" : "Typing…"), waiting }
      : undefined,
  );

  const policy = $derived<ApprovalPolicy>(
    config.approvalPolicy === "always" || config.approvalPolicy === "full_auto" ? config.approvalPolicy : "safe",
  );

  const modelInstances = $derived(
    botWizardInstances(
      instances,
      [...catalogs.workers.values()].filter(
        (w) => splitId(w.workerId).node === (bot.nodeId ? nodeRef(bot.nodeId) : undefined),
      ),
    ),
  );

  $effect(() => botList.use());

  function markVisibleRead() {
    const last = snapshot.messages.at(-1)?.seq;

    if (
      !home.reason &&
      history.live &&
      snapshot.bot &&
      last &&
      last > snapshot.bot.lastReadSeq &&
      document.visibilityState === "visible"
    ) {
      void botList.markRead(snapshot.bot.id, last).catch(() => undefined);
    }
  }

  $effect(() => {
    markVisibleRead();
  });

  $effect(() => {
    document.addEventListener("visibilitychange", markVisibleRead);

    return () => document.removeEventListener("visibilitychange", markVisibleRead);
  });

  $effect(() => {
    const id = data.bot.id;

    if (botList.list.some((b) => b.id === id)) observedBotId = id;
    else if (observedBotId === id && botList.loaded && !botList.error) void goto("/bots", { replace: true });
  });

  $effect(() => {
    const view = lifetime;
    pending = [];
    answering = {};
    connection = "";
    sending = false;

    return () => {
      view.active = false;

      if (observedBotId === view.botId) observedBotId = undefined;
    };
  });

  async function deliver(
    view: { botId: string; active: boolean },
    item: {
      id: string;
      text: string;
      mentions: Mention[];
      quotes: ui.Quote[];
      attachments: ui.Attachment[];
      revision: bigint | undefined;
    },
  ) {
    if (view.active) sending = true;

    try {
      await requestJson("POST", `/api/bots/${view.botId}/messages`, {
        text: item.text,
        mentions: mentionsToWire(item.mentions),
        quotes: item.quotes.map((q) => encode(ui.QuoteSchema, q)),
        clientRequestId: item.id,
        attachmentIds: item.attachments.map((a) => a.id),
        draftRevision: item.revision?.toString(),
      });

      return true;
    } catch {
      if (view.active) pending = pending.map((p) => (p.id === item.id ? { ...p, failed: true } : p));

      return false;
    } finally {
      if (view.active) sending = false;
    }
  }

  function send() {
    if (!canAct) return;
    // The draft flush may finish after navigation. Delivery belongs to the bot selected now.
    const view = lifetime;
    const baseline = yours.length;

    return composerDraft.send((text, mentions, quotes, attachments, requestId, revision) => {
      const item = {
        id: requestId,
        text,
        mentions,
        quotes,
        attachments,
        revision,
        at: new Date(),
        baseline,
        failed: false,
      };

      if (view.active) pending = [...pending.filter((p) => p.id !== item.id), item];

      return deliver(view, item);
    });
  }

  function resend() {
    const failed = pending.find((p) => p.failed);

    if (!failed) return;
    const draft = composerDraft;
    const view = lifetime;
    pending = pending.map((p) => (p === failed ? { ...p, failed: false } : p));
    void deliver(view, failed).then(async (accepted) => {
      if (accepted && draft.sync.value.clientRequestId === failed.id) await draft.sync.sent(draft.sync.value);
    });
  }

  async function reply(id: string, body: { approve: boolean; answer: string; ruleOptionId?: string }, mark: string) {
    if (!canAct || !canAnswerBotApproval(snapshot, id, history.live)) return;
    const view = lifetime;
    answering = { ...answering, [id]: mark };

    try {
      await requestJson(
        "POST",
        `/api/bot-approvals/${id}`,
        encode(
          bots.AnswerBotApprovalRequestSchema,
          create(bots.AnswerBotApprovalRequestSchema, { approvalId: id, ...body }),
        ),
      );
    } catch (cause) {
      if (!view.active) return;
      connection = cause instanceof Error ? cause.message : "Could not send your answer";

      if (connection.includes("This request expired.")) {
        snapshot = {
          ...snapshot,
          approvals: snapshot.approvals.map((a) => (a.id === id ? { ...a, status: "expired" } : a)),
        };
        connection = "This request expired. No answer was sent.";
      }
    } finally {
      if (view.active) {
        const { [id]: _, ...rest } = answering;
        answering = rest;
      }
    }
  }

  function answer(id: string, option: string) {
    const question = snapshot.approvals.find((a) => a.id === id);

    if (option === "discard") return reply(id, { approve: false, answer: "" }, option);

    const text = option.startsWith("text:")
      ? option.slice(5)
      : (question?.options[Number(option.replace("option:", ""))] ?? "");

    return reply(id, { approve: true, answer: text }, option);
  }

  function approve(id: string, choice: ApprovalAnswer) {
    if (choice.approve) return reply(id, { approve: true, answer: "", ruleOptionId: choice.ruleOptionId }, "approve");

    return reply(id, { approve: false, answer: choice.edited ?? "" }, choice.edited ? "edit" : "discard");
  }

  async function save(configuration: bots.BotConfiguration) {
    await botList.save(bot, configuration);
  }

  async function setPolicy(next: ApprovalPolicy) {
    try {
      await save(create(bots.BotConfigurationSchema, { ...config, approvalPolicy: next }));
    } catch {
      connection = "Could not change when this bot asks";

      return;
    }
  }

  async function changeModel(choice: BotModelChoice) {
    const instance = instances.find((i) => instanceKeyOf(i) === choice.providerInstanceId);

    if (!instance) throw new Error("This provider instance is no longer available");
    await save(
      create(bots.BotConfigurationSchema, {
        ...config,
        provider: instance.harness,
        providerInstance: instance.id,
        model: choice.model,
        effort: choice.effort ?? "",
        serviceTier: choice.serviceTier ?? "",
      }),
    );
  }

  async function openChangeModel() {
    try {
      instances = decode(
        ui.ListProviderInstancesResponseSchema,
        await requestJson("GET", `/api/bots/${bot.id}/providers`),
      ).instances;
      changingModel = true;
    } catch {
      connection = "Could not load your provider instances";
    }
  }

  async function retry() {
    retrying = true;

    try {
      await requestJson("POST", `/api/bots/${data.bot.id}/retry`, {});
    } catch (cause) {
      connection = cause instanceof Error ? cause.message : "Could not retry";
    } finally {
      retrying = false;
    }
  }

  async function setReaction(messageId: string, emoji: string, active: boolean) {
    if (!canAct) return;
    const view = lifetime;

    try {
      await requestJson("PUT", `/api/bots/${view.botId}/messages/${encodeURIComponent(messageId)}/reactions`, {
        emoji,
        active,
      });

      if (view.active && connection === reactionError) connection = "";
    } catch {
      if (view.active) connection = reactionError;
    }
  }

  async function interrupt() {
    if (stopping) return;
    stopping = true;

    try {
      await requestJson("POST", `/api/bots/${data.bot.id}/interrupt`, {});
    } catch {
      connection = "Could not stop the reply. Check the connection and retry.";
    } finally {
      stopping = false;
    }
  }
</script>

<svelte:head><title>{config.name || "Bot"} · {applicationName}</title></svelte:head>
<Dialog
  bind:open={ruleDialog}
  title="Allowed actions"
  description="Removing a rule makes the next matching request follow the bot’s approval setting."
>
  <BotApprovalRules
    botId={bot.id}
    selectedRule={page.url.searchParams.get("rule") ?? ""}
    disabled={!canAct}
    showHeading={false}
  />
</Dialog>
<div class="flex h-full min-h-0 flex-col">
  {#key data.bot.id}
    <BotDetailsLayout bind:this={detailsLayout} bind:open={detailsOpen} ownerId={bot.ownerUserId}>
      {#snippet panel()}<BotDetailsPanel
          {bot}
          delegatedThreads={settings.moduleEnabled("threads")
            ? (botList.delegatedThreads(listedBot) ?? null)
            : undefined}
          routines={snapshot.routines}
          triggers={snapshot.triggers}
          waiting={snapshot.approvals.filter((a) => a.parked && a.status === "pending")}
          onreveal={(id) => {
            detailsLayout?.closeOverlay();
            void chatView?.reveal(id);
          }}
          reminders={snapshot.reminders}
          status={snapshot.statusLine}
          onclose={closeDetails}
        />{/snippet}
      <ChatView
        bind:this={chatView}
        {composerDraft}
        {history}
        {conversation}
        {entries}
        me={{ id: "me", kind: "user", name: "You" }}
        {directory}
        subtitle={config.model
          ? `${modelDisplayName(config.model)}${config.provider === Provider.CODEX ? " · Codex" : config.provider === Provider.GROK ? " · Grok" : " · Claude"}`
          : undefined}
        {status}
        {sending}
        running={snapshot.working}
        {stopping}
        onstop={canAct ? interrupt : undefined}
        {answering}
        {retrying}
        {policy}
        composerDisabledReason={home.reason || (!history.live ? "Syncing…" : undefined)}
        loading={!history.snapshot}
        syncing={!history.live}
        onreact={canAct ? setReaction : undefined}
        onanswer={canAct ? answer : undefined}
        onapprove={canAct ? approve : undefined}
        onpolicy={canAct ? setPolicy : undefined}
        exchangeHref={(segment) => `/bots/${data.bot.id}/exchanges/${segment.exchangeId}`}
        onsend={send}
        onretry={canAct ? retry : undefined}
        onchangemodel={canAct ? openChangeModel : undefined}
        onchangeworker={canAct ? () => openBotSettings(bot.id) : undefined}
        class="flex-1"
      >
        {#snippet notice()}
          <MovedBotNotice {bot} class="px-4 py-2 sm:px-6" />
          {#if home.reason}
            <div class="px-4 py-2 sm:px-6">
              <Alert tone="warning" banner title="Read only for now"
                >{home.reason} You can read the synced conversation. Messages, approvals and settings are unavailable; nothing
                is queued.</Alert
              >
            </div>
          {/if}
        {/snippet}
        {#snippet actions()}
          <IconButton
            icon="information-circle"
            label="Bot details"
            aria-expanded={detailsLayout?.isExpanded() ?? false}
            onclick={(event) => {
              detailsToggle = event.currentTarget;
              detailsLayout?.toggle();
            }}
          />
          <DropdownMenu label="Bot actions" placement="bottom-end" class="w-max max-w-[calc(100vw-1rem)]">
            {#snippet trigger(props)}<IconButton icon="ellipsis-horizontal" label="Bot actions" {...props} />{/snippet}
            {#if !bot.archived && snapshot.messages.length}
              <MenuItem
                icon="light-bulb"
                disabled={!canAct || !composerDraft.loaded || composerDraft.sending || sending}
                onselect={learn}
              >
                {learnFromConversation.label}
              </MenuItem>
            {/if}
            <MenuItem icon="pencil-square" disabled={Boolean(home.reason)} onselect={() => openBotSettings(bot.id)}
              >Edit bot…</MenuItem
            >
            {#if !bot.archived}<MenuItem
                icon="star"
                onselect={() => {
                  void settings.pinBot(bot.id, !conversation.pinned);
                }}>{conversation.pinned ? "Unpin" : "Pin to top"}</MenuItem
              >{/if}
            <MenuItem
              icon="archive-box"
              disabled={Boolean(home.reason)}
              onselect={() => {
                void archiveBot(bot, !bot.archived)
                  .then(() => settings.pinBot(bot.id, false))
                  .catch(reportLifecycleError);
              }}>{bot.archived ? "Unarchive bot" : "Archive bot"}</MenuItem
            >
            <MenuItem icon="trash" disabled={Boolean(home.reason)} onselect={() => openBotDeletion(bot)}
              >Delete bot</MenuItem
            >
            {#if capabilities?.linkedComputers && !bot.nodeId}<MenuItem
                icon="arrows-right-left"
                onselect={() => window.dispatchEvent(new CustomEvent("move-bot", { detail: bot.id }))}
                >Move to…</MenuItem
              >{/if}
          </DropdownMenu>
        {/snippet}
        {#snippet archived()}
          {#if bot.archived}<div
              class="flex flex-wrap items-center justify-center gap-3 rounded-xl bg-zinc-950/3 p-4 text-base/6 sm:text-sm/6 dark:bg-white/4"
            >
              <p class="text-zinc-500 dark:text-zinc-400">{config.name} is archived</p>
              <Button
                onclick={() => {
                  void archiveBot(bot, false).catch(reportLifecycleError);
                }}>Unarchive</Button
              >
            </div>{/if}
        {/snippet}
      </ChatView>
    </BotDetailsLayout>
  {/key}
  {#if connection || pending.some((p) => p.failed)}
    <div
      role={expiredNotice ? "status" : "alert"}
      class={[
        "flex items-center justify-center gap-3 border-t border-zinc-950/5 px-4 py-2 text-sm/5 dark:border-white/5",
        expiredNotice ? "text-zinc-500 dark:text-zinc-400" : "text-rose-600 dark:text-rose-400",
      ]}
    >
      {connection || "Your message was not sent."}
      {#if !bot.archived && pending.some((p) => p.failed)}<Button size="sm" variant="ghost" onclick={resend}
          >Send again</Button
        >{/if}
    </div>
  {/if}
</div>
<ChangeModelDialog
  bind:open={changingModel}
  botName={config.name}
  instances={modelInstances}
  initial={{
    providerInstanceId: instanceKeyOf({ harness: config.provider, id: config.providerInstance }),
    model: config.model,
    effort: config.effort || undefined,
    serviceTier: config.serviceTier || undefined,
  }}
  onsave={changeModel}
/>

<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import { webDrafts } from "#lib/features/drafts/local.svelte.ts";
  import DraftPersistence from "#lib/features/drafts/DraftPersistence.svelte";
  import DraftActions from "#lib/features/drafts/DraftActions.svelte";
  import type { ClassValue } from "svelte/elements";
  import { limitsOf } from "#lib/features/attachments/draft.svelte.ts";
  import { trimValue } from "#lib/features/mentions/editor.ts";
  import { toWire, useQuoteDrafts } from "#lib/features/quotes/quote-drafts.svelte.ts";
  import { draftOf } from "#lib/features/quotes/quote.ts";
  import { HttpError } from "#lib/shared/http.ts";
  import { MentionSources } from "#lib/features/mentions/sources.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { modelOption, type ModelOption } from "#lib/features/models/catalog.ts";
  import { composerChoices } from "@canopy/domain/composer-choices";
  import { providerKeyOf } from "../providers.ts";
  import { PermissionMode, Provider } from "@canopy/contracts";
  import { useThreadModels } from "#lib/features/models/model-catalog.svelte.ts";
  import ModelControls from "#lib/features/models/ModelControls.svelte";
  import WorkerHoverCard from "#lib/features/overview/WorkerHoverCard.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import PillText from "#lib/shared/ui/PillText.svelte";
  import { interruptThread, sendMessage, type Delivery } from "../api.ts";
  import { permissionKey, providerLabel, type PermissionModeKey } from "../labels.ts";
  import ComposerBox from "./ComposerBox.svelte";
  import { contextDraft } from "#lib/features/github/context-draft.svelte.ts";
  import { tick, untrack } from "svelte";
  import { page } from "$app/state";
  import type { ComposerActivity } from "./composer-compaction.ts";
  import PermissionPicker from "./PermissionPicker.svelte";
  import ComposerContextRow from "./ComposerContextRow.svelte";
  import AccountConfigNotices from "#lib/features/computers/AccountConfigNotices.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { computerName } from "@canopy/domain/computer-presence";
  import { registerUnsentWork } from "#lib/features/workers/unsent-work.ts";
  import type { ComposerConnection } from "@canopy/domain/composer-connection";
  import { useThreadRewind } from "../rewind-state.svelte.ts";
  import { ComposerRewind } from "../composer-rewind.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import UsageWarning from "#lib/features/providers/UsageWarning.svelte";

  /**
   * Message box of a thread. Each send carries an idempotency key, so a retried send never runs
   * twice. While a turn runs, a typed message is steered into it (Enter) or queued for the next turn
   * (Mod+Enter or the send button's menu), and the empty box offers Stop. `onsent` gets the result (the
   * queued turn or the steer) so the page shows it before the stream does.
   * Pills: the model and reasoning effort for the next messages (same provider and profile as the
   * thread), restored from the last user turn and sent with each message as an override for its turn.
   * Under the box: where the thread runs (hover for the worker) and the next turn's permission mode.
   * A running turn and a steer into it keep the mode the turn started with.
   * Attachments (paperclip, drop, paste): badges in the text, uploaded as they are added, sent with the message at
   * their places. Files reach the worker before the message enters a turn, including when steered.
   * Mentions ("/", "$", "@", "#"; docs/ui-api.md "Wzmianki") come from the thread's worker and folder; "/goal" is
   * the platform's command: the rest of the message becomes the thread's goal.
   * Quotes (Cite on the agent's output; docs/ui-api.md "Cytaty") are atomic inline tokens at the caret;
   * their ranges go with the message (steered too). A message may be quotes alone.
   */
  let {
    thread,
    worker,
    running,
    runningTurnId,
    connection,
    disabled = false,
    note,
    onsent,
    ongoal,
    compact = false,
    panelsLabel,
    onexpand,
    class: className,
  }: {
    thread: ui.Thread;
    worker: ui.Worker | undefined;
    running: boolean;
    runningTurnId?: string | undefined;
    connection?: ComposerConnection | undefined;
    disabled?: boolean;
    note?: string | undefined;
    onsent?: ((response: ui.SendMessageResponse) => void) | undefined;
    /** Offers "Set a goal" in the composer's "+" menu. */
    ongoal?: (() => void) | undefined;
    compact?: boolean;
    panelsLabel?: string;
    onexpand?: ((activity?: ComposerActivity) => void) | undefined;
    class?: ClassValue;
  } = $props();

  // The thread's provider and profile stay; only models on them are offered. `current` = the thread's default.
  const offer = useThreadModels(() => ({ thread, worker }));

  const settings = useSettings();

  const saved = $derived(
    webDrafts.get(create(ui.ComposerDraftTargetSchema, { threadId: thread.id }), () =>
      limitsOf(settings?.attachmentLimits),
    ),
  );

  const mine = $derived(saved.choices);

  const models = $derived(
    (mine.model !== undefined && !offer.options.some((o) => o.model === mine.model)
      ? [
          ...offer.options,
          modelOption(providerKeyOf(thread.provider) ?? "CODEX", thread.providerProfileId, "", mine.model, undefined),
        ]
      : offer.options
    ).map((option) => ({
      ...option,
      efforts: option.efforts.map((e) => e.id),
      option,
    })),
  );

  const selected = $derived(composerChoices(thread, models, mine));
  const option = $derived(selected.option?.option);
  const effort = $derived(selected.effort || undefined);
  const mode = $derived(permissionKey(selected.permissionMode));
  const override = $derived({ model: option?.model, effort: selected.effort, permissionMode: mode });

  function pickModel(next: ModelOption | undefined) {
    if (!next) return;
    saved.choices = { ...mine, model: next.model, effort: selected.effort };
  }

  function pickEffort(next: string | undefined) {
    saved.choices = { ...mine, effort: next ?? "" };
  }

  function pickMode(next: PermissionModeKey) {
    saved.choices = { ...mine, permissionMode: PermissionMode[next] };
  }

  let box = $state<ComposerBox>();

  $effect(() => {
    const pending = contextDraft.pending;

    // Native modal focus makes the thread editor inert until the PR sheet is removed.
    if (!box || pending?.threadId !== thread.id || page.url.searchParams.has("pr")) return;
    const composer = box;
    untrack(() => {
      contextDraft.pending = undefined;
      void tick()
        .then(() => composer.acceptContext(pending.context))
        .catch(() => {
          error = "Could not add PR context. Remove an attachment, then retry.";
        });
    });
  });

  // The thread's worker, provider and folder (a side thread has its own); "#" offers every thread but this one.
  const sources = new MentionSources(
    () => (thread.runtime === "worker" && thread.workerId ? { threadId: thread.id } : undefined),
    () => thread.id,
  );

  const draft = $derived(saved.files);
  const quoteDrafts = useQuoteDrafts();
  const quotes = $derived(quoteDrafts.list(thread.id));
  const rewind = useThreadRewind();

  const editorRewind = $derived(new ComposerRewind(saved));

  $effect(() => rewind?.().connect(() => !sending && !saved.locked && !draft.blocker));

  $effect(() => {
    const state = rewind?.();
    const restored = state?.draft;

    if (!state || !restored || saved.locked || draft.blocker) return;
    untrack(() => {
      editorRewind.load(restored);
      state.draft = undefined;
      void tick().then(() => box?.focus());
    });
  });

  let sending = $state(false);
  const draftSwapBlocked = $derived(saved.locked || Boolean(draft.blocker) || Boolean(rewind?.().busy));
  let waiting = $state(false);
  const overview = useOverview();

  $effect(() => registerUnsentWork(() => !!saved.text.length || !!draft.attached.length || !!quotes.length || sending));

  const homeName = $derived(thread.nodeId ? computerName(overview?.computer(thread.nodeId)) : "this computer");

  let stopping = $state(false);
  let error = $state<string | undefined>(undefined);
  let composerAvailable = $state(true);
  const scopeId = $derived(thread.id);
  const lifetime = $derived({ threadId: scopeId, controller: new AbortController() });

  $effect(() => {
    const current = connection;

    const update = () => {
      composerAvailable = current?.composerAvailable ?? true;
    };

    update();

    return current?.subscribe(update);
  });

  $effect(() => {
    const { controller } = lifetime;

    return () => controller.abort();
  });

  /** What happened to the last message when it did not go the way it was sent (a steer that became a turn). */
  let outcome = $state<string | undefined>(undefined);
  const deliveryStatus = $derived(sending ? (waiting ? `Still waiting for ${homeName}…` : "Sending…") : outcome);

  // One key per message: a retry after a network error reuses it, a new message gets a new one.

  // While a turn runs Enter steers, or queues when queueing is on (Settings, the queue panel's menu).
  const primary = $derived(settings?.runningDelivery ?? "steer");

  function submit(event: SubmitEvent) {
    event.preventDefault();
    void send(running ? primary : "queue");
  }

  async function send(delivery: Delivery) {
    const composer = saved;
    const files = composer.files;
    const trimmed = trimValue({ text: saved.text, mentions: saved.mentions, quotes });
    const message = saved.text.trimStart().startsWith("!") ? saved.text.trimEnd() : trimmed.text;
    const sentMentions = trimmed.mentions;

    if (
      (!message && draft.attached.length === 0 && quotes.length === 0) ||
      sending ||
      composer.preparing ||
      disabled ||
      !composerAvailable
    )
      return;

    if (draft.blocker) {
      error = draft.blocker;

      return;
    }

    const attachmentIds = draft.ids;
    const sentOverride = { ...override };
    const threadId = thread.id;
    const sentQuotes = trimmed.quotes ?? [];
    const attempt = new AbortController();
    const view = lifetime;
    const signal = attempt.signal;
    composer.pendingAbort = () => attempt.abort();
    let outgoingRequestId = composer.requestId;
    sending = true;
    composer.preparing = true;
    waiting = false;
    error = undefined;
    outcome = undefined;

    try {
      let request = composer.pendingSend;

      if (!request) {
        const published = await composer.publishForSend();
        request = create(ui.SendMessageRequestSchema, {
          threadId,
          text: message,
          clientRequestId: composer.requestId,
          ...sentOverride,
          permissionMode: PermissionMode[sentOverride.permissionMode],
          delivery: delivery === "steer" ? ui.MessageDelivery.STEER : ui.MessageDelivery.QUEUE,
          attachmentIds,
          mentions: files.wire(sentMentions),
          quotes: sentQuotes.map((q) => create(ui.QuoteSchema, toWire(q))),
          draftId: published?.id ?? "",
          draftRevision: published?.revision ?? 0n,
        });
        await composer.beginSend(request);
      }

      outgoingRequestId = request.clientRequestId;

      const response = await sendMessage(
        request.threadId,
        request.text,
        request.clientRequestId,
        {
          model: request.model,
          effort: request.effort,
          permissionMode: request.permissionMode ? permissionKey(request.permissionMode) : undefined,
        },
        request.delivery === ui.MessageDelivery.STEER ? "steer" : "queue",
        request.attachmentIds,
        request.mentions,
        request.quotes.map((q) => toWire(draftOf(q))),
        () => {
          waiting = true;
        },
        {
          signal,
        },
        request.draftId ? { draftId: request.draftId, draftRevision: request.draftRevision.toString() } : undefined,
      );

      if (composer.requestId === outgoingRequestId) composer.clear();

      if (signal.aborted || view.controller.signal.aborted) return;
      onsent?.(response);

      if (response.goal) outcome = `Goal set: ${response.goal.objective}`;

      // Steered while the turn was ending: the gateway queued it as the next turn.
      if (delivery === "steer" && response.turn)
        outcome = response.deliveryNote || "The turn ended. Your message runs as the next turn.";

      // Only the quotes that went: one cited while the message was on its way stays for the next.
      for (const quote of sentQuotes) quoteDrafts.remove(threadId, quote.id);
    } catch (e) {
      const canceled = signal.aborted || view.controller.signal.aborted;

      if (e instanceof HttpError && ![408, 502, 503, 504].includes(e.status))
        composer.cancelSend(e.status === 409 || e.status === 404);

      if (!canceled) error = e instanceof Error ? e.message : String(e);
    } finally {
      composer.pendingAbort = undefined;
      composer.preparing = false;
      void composer.reconcile();

      if (!view.controller.signal.aborted) sending = false;
    }
  }

  async function interrupt() {
    if (stopping || disabled) return;
    const turnId = runningTurnId;
    const threadId = thread.id;
    const signal = lifetime.controller.signal;
    stopping = true;
    error = undefined;

    try {
      await connection?.waitUntilLive(signal);

      if (disabled || !running || turnId !== runningTurnId) return;
      await interruptThread(threadId);
    } catch (e) {
      if (!signal.aborted) error = e instanceof Error ? e.message : String(e);
    } finally {
      stopping = false;
    }
  }
</script>

<DraftPersistence draft={saved} />

<form class={["grid grid-cols-1 gap-2", className]} onsubmit={submit}>
  {#if rewind?.().busy}<p class="text-sm/5 text-muted" role="status">Editing this thread…</p>{/if}
  {#if rewind?.().error}
    <Alert tone="error"
      >{rewind?.().error}{#if rewind?.().canRetry}<Button
          variant="ghost"
          size="sm"
          onclick={() => void rewind?.().retry()}>Retry</Button
        >{/if}</Alert
    >
  {/if}
  {#if editorRewind.saved.length}
    <div class="flex flex-wrap items-center gap-2 text-sm/5 text-muted">
      <span>Your previous draft is saved.</span><Button
        variant="ghost"
        size="sm"
        disabled={draftSwapBlocked}
        onclick={() => {
          if (draftSwapBlocked) return;
          editorRewind.swap();
          void tick().then(() => box?.focus());
        }}>Swap drafts</Button
      >
    </div>
  {/if}
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  <UsageWarning
    usage={worker?.providerInstances.find(
      (instance) => instance.harness === thread.provider && instance.id === (thread.providerProfileId || "native"),
    )?.usage}
    href={`/settings/providers?instance=${Provider[thread.provider]}:${encodeURIComponent(thread.providerProfileId || "native")}&worker=${encodeURIComponent(thread.workerId)}`}
  />
  <ComposerBox
    bind:this={box}
    shell
    {compact}
    {panelsLabel}
    {onexpand}
    bind:value={saved.text}
    bind:mentions={saved.mentions}
    {sources}
    placeholder={running ? "Steer the agent, or queue for the next turn…" : "Ask anything…"}
    disabled={disabled || sending || !composerAvailable}
    readonly={saved.locked}
    stopDisabled={disabled}
    {sending}
    {stopping}
    onstop={running ? interrupt : undefined}
    onqueue={running ? () => void send("queue") : undefined}
    {primary}
    onalternate={running ? () => void send("steer") : undefined}
    {draft}
    blockedReason={disabled ? note : undefined}
    deliveryNotice={outcome}
    elementCount={quotes.length}
    quoteKey={thread.id}
    {ongoal}
  >
    {#snippet controls()}
      <fieldset disabled={disabled || sending} class="contents">
        {#if option}
          <ModelControls
            options={offer.options}
            bind:option={() => option, pickModel}
            bind:effort={() => effort, pickEffort}
            inherited={thread.effort || undefined}
            workerId={thread.workerId}
            class="flex-1 justify-end"
          />
        {:else}
          <PillText class="flex-1 text-right">{providerLabel(thread.provider)}</PillText>
        {/if}
      </fieldset>
    {/snippet}
    {#snippet meta()}
      <ComposerContextRow>
        {#snippet computerControl()}
          <DraftActions
            draft={saved}
            threadId={thread.id}
            disabled={disabled || saved.locked || Boolean(rewind?.().busy)}
          >
            <!-- Delivery feedback shares the location slot so it never adds a blank row below the composer. -->
            <div class="relative w-full min-w-0">
              <div class:invisible={Boolean(deliveryStatus)}>
                <WorkerHoverCard {worker} {note} class="max-w-full" />
              </div>
              <p
                class="absolute inset-0 flex min-w-0 items-center"
                class:pointer-events-none={!deliveryStatus}
                title={deliveryStatus}
                aria-hidden="true"
              >
                <span class="truncate">{deliveryStatus ?? ""}</span>
              </p>
            </div>
          </DraftActions>
        {/snippet}
        {#snippet permissionControl()}
          <fieldset disabled={disabled || sending} class="contents">
            <PermissionPicker value={mode} onselect={(next) => void pickMode(next)} />
          </fieldset>
        {/snippet}
      </ComposerContextRow>
    {/snippet}
  </ComposerBox>
  <!-- Keep announcements mounted even when the metadata folds in the compact composer. -->
  <p class="sr-only" role="status" aria-atomic="true">{deliveryStatus ?? ""}</p>
</form>
<AccountConfigNotices section="composer" />

<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import type { Mention } from "@canopy/contracts";
  import { AttachmentDraft, limitsOf } from "#lib/features/attachments/draft.svelte.ts";
  import { trimValue } from "#lib/features/mentions/editor.ts";
  import { toWire, useQuoteDrafts } from "#lib/features/quotes/quote-drafts.svelte.ts";
  import { MentionSources } from "#lib/features/mentions/sources.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { type ModelOption } from "#lib/features/models/catalog.ts";
  import { composerChoices, type ComposerPick } from "@canopy/domain/composer-choices";
  import { PermissionMode } from "@canopy/contracts";
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

  let choices = $state.raw<Record<string, ComposerPick & { custom?: ModelOption }>>({});
  const mine = $derived(choices[thread.id]);

  const models = $derived(
    [...offer.options, ...(mine?.custom ? [mine.custom] : [])].map((option) => ({
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
    choices = {
      ...choices,
      [thread.id]: {
        ...mine,
        model: next.model,
        effort: selected.effort,
        ...(next.origin === "custom" && { custom: next }),
      },
    };
  }

  function pickEffort(next: string | undefined) {
    choices = { ...choices, [thread.id]: { ...mine, effort: next ?? "" } };
  }

  function pickMode(next: PermissionModeKey) {
    choices = { ...choices, [thread.id]: { ...mine, permissionMode: PermissionMode[next] } };
  }

  let text = $state("");
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

  let mentions = $state<Mention[]>([]);

  // The thread's worker, provider and folder (a side thread has its own); "#" offers every thread but this one.
  const sources = new MentionSources(
    () => (thread.runtime === "worker" && thread.workerId ? { threadId: thread.id } : undefined),
    () => thread.id,
  );

  const settings = useSettings();
  const draft = new AttachmentDraft(() => limitsOf(settings?.attachmentLimits));
  const quoteDrafts = useQuoteDrafts();
  const quotes = $derived(quoteDrafts.list(thread.id));
  const rewind = useThreadRewind();

  const editorRewind = new ComposerRewind(
    () => ({ threadId: thread.id, text, mentions }),
    (next, chips) => {
      text = next;
      mentions = chips;
    },
    draft,
    quoteDrafts,
  );

  $effect(() => rewind?.().connect(() => !sending && !draft.uploading && !draft.failed));

  $effect(() => {
    const state = rewind?.();
    const restored = state?.draft;

    if (!state || !restored) return;
    untrack(() => {
      editorRewind.load(restored);
      state.draft = undefined;
      requestId = crypto.randomUUID();
      void tick().then(() => box?.focus());
    });
  });

  let sending = $state(false);
  let waiting = $state(false);
  const overview = useOverview();

  $effect(() => registerUnsentWork(() => !!text.length || !!draft.attached.length || !!quotes.length || sending));

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
  let requestId = crypto.randomUUID();

  // While a turn runs Enter steers, or queues when queueing is on (Settings, the queue panel's menu).
  const primary = $derived(settings?.runningDelivery ?? "steer");

  function submit(event: SubmitEvent) {
    event.preventDefault();
    void send(running ? primary : "queue");
  }

  async function send(delivery: Delivery) {
    const trimmed = trimValue({ text, mentions, quotes });
    const message = text.trimStart().startsWith("!") ? text.trimEnd() : trimmed.text;
    const sentMentions = trimmed.mentions;

    if ((!message && draft.attached.length === 0 && quotes.length === 0) || sending || disabled || !composerAvailable)
      return;

    if (draft.blocker) {
      error = draft.blocker;

      return;
    }

    const attachmentIds = draft.ids;
    const threadId = thread.id;
    const sentQuotes = trimmed.quotes ?? [];
    const signal = lifetime.controller.signal;
    sending = true;
    waiting = false;
    error = undefined;
    outcome = undefined;

    try {
      const response = await sendMessage(
        threadId,
        message,
        requestId,
        override,
        delivery,
        attachmentIds,
        draft.wire(sentMentions),
        sentQuotes.map(toWire),
        () => {
          waiting = true;
        },
        {
          signal,
          beforeAttempt: async () => {
            await connection?.waitUntilLive(signal);
          },
        },
      );

      if (signal.aborted) return;
      onsent?.(response);

      if (response.goal) outcome = `Goal set: ${response.goal.objective}`;

      // Steered while the turn was ending: the gateway queued it as the next turn.
      if (delivery === "steer" && response.turn)
        outcome = response.deliveryNote || "The turn ended. Your message runs as the next turn.";
      text = "";
      mentions = [];
      draft.clear();

      // Only the quotes that went: one cited while the message was on its way stays for the next.
      for (const quote of sentQuotes) quoteDrafts.remove(threadId, quote.id);
      requestId = crypto.randomUUID();
    } catch (e) {
      if (!signal.aborted) error = e instanceof Error ? e.message : String(e);
    } finally {
      sending = false;
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
        onclick={() => {
          editorRewind.swap();
          void tick().then(() => box?.focus());
        }}>Swap drafts</Button
      >
    </div>
  {/if}
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  <ComposerBox
    bind:this={box}
    shell
    {compact}
    {panelsLabel}
    {onexpand}
    bind:value={text}
    bind:mentions
    {sources}
    placeholder={running ? "Steer the agent, or queue for the next turn…" : "Ask anything…"}
    disabled={disabled || sending || !composerAvailable}
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

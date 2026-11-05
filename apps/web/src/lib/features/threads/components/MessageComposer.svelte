<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import type { Mention } from "@canopy/contracts";
  import { AttachmentDraft, limitsOf } from "#lib/features/attachments/draft.svelte.ts";
  import { trimValue } from "#lib/features/mentions/editor.ts";
  import { toWire, useQuoteDrafts } from "#lib/features/quotes/quote-drafts.svelte.ts";
  import QuoteTray from "#lib/features/quotes/QuoteTray.svelte";
  import { MentionSources } from "#lib/features/mentions/sources.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { turnOverride, type ModelOption } from "#lib/features/models/catalog.ts";
  import { useThreadModels } from "#lib/features/models/model-catalog.svelte.ts";
  import ModelControls from "#lib/features/models/ModelControls.svelte";
  import WorkerHoverCard from "#lib/features/overview/WorkerHoverCard.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import PillText from "#lib/shared/ui/PillText.svelte";
  import { interruptThread, sendMessage, updateThread, type Delivery } from "../api.ts";
  import { permissionKey, providerLabel, type PermissionModeKey } from "../labels.ts";
  import ComposerBox from "./ComposerBox.svelte";
  import type { ComposerActivity } from "./composer-compaction.ts";
  import PermissionPicker from "./PermissionPicker.svelte";
  import ComposerContextRow from "./ComposerContextRow.svelte";

  /**
   * Message box of a thread. Each send carries an idempotency key, so a retried send never runs
   * twice. While a turn runs, a typed message is steered into it (Enter) or queued for the next turn
   * (Mod+Enter or the send button's menu), and the empty box offers Stop. `onsent` gets the result (the
   * queued turn or the steer) so the page shows it before the stream does.
   * Pills: the model and reasoning effort for the next messages (same provider and profile as the
   * thread), sent with each message as an override for its turn; unchanged = the thread's defaults.
   * Under the box: where the thread runs (hover for the worker) and the thread's permission mode. A pick is
   * saved on the thread at once (UpdateThread) and applies from the next turn; the running turn and a steer
   * into it keep the mode the turn started with. Until the gateway confirms, a message sent meanwhile
   * carries the pick as its turn's override.
   * Attachments (paperclip, drop, paste): uploaded as they are added, sent with the message, which then always
   * runs as the next turn (its files reach the worker before the turn starts).
   * Mentions ("/", "$", "@", "#"; docs/ui-api.md "Wzmianki") come from the thread's worker and folder; "/goal" is
   * the platform's command: the rest of the message becomes the thread's goal.
   * Quotes (Cite on the agent's output; docs/ui-api.md "Cytaty") wait as chips above the text, in the thread's quote
   * drafts, and go with the message (steered too); a message may be quotes alone.
   */
  let {
    thread,
    worker,
    running,
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

  // Your choice for this thread's next messages (kept per thread; navigating to another starts fresh).
  let choice = $state<{ threadId: string; option?: ModelOption | undefined; effort?: string | undefined }>({
    threadId: "",
  });

  const mine = $derived(choice.threadId === thread.id ? choice : undefined);
  const option = $derived(mine?.option ?? offer.current);
  const effort = $derived(mine?.effort);
  const threadMode = $derived(permissionKey(thread.permissionMode));

  // A pick on its way to the gateway: shown until the thread's mode changes from the one it was made over.
  let modeChoice = $state.raw<{ threadId: string; mode: PermissionModeKey; over: PermissionModeKey }>();

  const pending = $derived(
    modeChoice?.threadId === thread.id && modeChoice.over === threadMode ? modeChoice : undefined,
  );

  const mode = $derived(pending?.mode ?? threadMode);

  const override = $derived({
    ...turnOverride(option, offer.current, effort, thread.effort),
    ...(mode !== threadMode && { permissionMode: mode }),
  });

  let text = $state("");
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
  let sending = $state(false);
  let stopping = $state(false);
  let error = $state<string | undefined>(undefined);

  /** What happened to the last message when it did not go the way it was sent (a steer that became a turn). */
  let outcome = $state<string | undefined>(undefined);

  // One key per message: a retry after a network error reuses it, a new message gets a new one.
  let requestId = crypto.randomUUID();

  // While a turn runs Enter steers, or queues when queueing is on (Settings, the queue panel's menu).
  const primary = $derived(settings?.runningDelivery ?? "steer");

  function submit(event: SubmitEvent) {
    event.preventDefault();
    void send(running ? primary : "queue");
  }

  async function send(delivery: Delivery) {
    const { text: message, mentions: sentMentions } = trimValue({ text, mentions });

    if ((!message && draft.files.length === 0 && quotes.length === 0) || sending || disabled) return;

    if (draft.blocker) {
      error = draft.blocker;

      return;
    }

    const attachmentIds = draft.ids;
    const threadId = thread.id;
    const sentQuotes = quotes;
    sending = true;
    error = undefined;
    outcome = undefined;

    try {
      const response = await sendMessage(
        threadId,
        message,
        requestId,
        override,
        attachmentIds.length > 0 ? "queue" : delivery,
        attachmentIds,
        sentMentions,
        sentQuotes.map(toWire),
      );

      onsent?.(response);

      if (response.goal) outcome = `Goal set: ${response.goal.objective}`;

      // Steered while the turn was ending: the gateway queued it as the next turn.
      if (delivery === "steer" && response.turn)
        outcome = "The turn had just ended, so your message runs as the next turn.";
      text = "";
      mentions = [];
      draft.clear();

      // Only the quotes that went: one cited while the message was on its way stays for the next.
      for (const quote of sentQuotes) quoteDrafts.remove(threadId, quote.id);
      requestId = crypto.randomUUID();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      sending = false;
    }
  }

  async function pickMode(next: PermissionModeKey) {
    if (next === mode) return;
    const pick = { threadId: thread.id, mode: next, over: threadMode };
    modeChoice = pick;
    error = undefined;

    try {
      await updateThread(pick.threadId, { permissionMode: next });
    } catch (e) {
      if (modeChoice === pick) modeChoice = undefined;
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function interrupt() {
    stopping = true;
    error = undefined;

    try {
      await interruptThread(thread.id);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      stopping = false;
    }
  }
</script>

<form class={["grid grid-cols-1 gap-2", className]} onsubmit={submit}>
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  <ComposerBox
    {compact}
    {panelsLabel}
    {onexpand}
    bind:value={text}
    bind:mentions
    {sources}
    placeholder={running ? "Steer the agent, or queue for the next turn…" : "Ask anything…"}
    {disabled}
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
    {ongoal}
  >
    {#snippet elements()}<QuoteTray threadId={thread.id} class="px-3 pt-3" />{/snippet}
    {#snippet controls()}
      <fieldset {disabled} class="contents">
        {#if option}
          <ModelControls
            options={offer.options}
            bind:option={() => option, (next) => (choice = { threadId: thread.id, option: next, effort: mine?.effort })}
            bind:effort={() => effort, (next) => (choice = { threadId: thread.id, option: mine?.option, effort: next })}
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
        {#snippet computerControl()}<WorkerHoverCard {worker} {note} class="max-w-full" />{/snippet}
        {#snippet permissionControl()}
          <fieldset {disabled} class="contents">
            <PermissionPicker value={mode} onselect={(next) => void pickMode(next)} />
          </fieldset>
        {/snippet}
      </ComposerContextRow>
    {/snippet}
  </ComposerBox>
  {#if outcome}<p class="sr-only" role="status">{outcome}</p>{/if}
</form>

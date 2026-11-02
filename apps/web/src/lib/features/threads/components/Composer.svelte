<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { turnOverride, type ModelOption } from "#lib/features/models/catalog.ts";
  import { useThreadModels } from "#lib/features/models/model-catalog.svelte.ts";
  import ModelControls from "#lib/features/models/ModelControls.svelte";
  import WorkerHoverCard from "#lib/features/overview/WorkerHoverCard.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import PillText from "#lib/shared/ui/PillText.svelte";
  import { interruptThread, sendMessage, type Delivery } from "../api.ts";
  import { permissionKey, providerLabel, type PermissionModeKey } from "../labels.ts";
  import ComposerBox from "./ComposerBox.svelte";
  import PermissionPicker from "./PermissionPicker.svelte";

  /**
   * Message box of a thread. Each send carries an idempotency key, so a retried send never runs
   * twice. While a turn runs, a typed message is steered into it (Enter) or queued for the next turn
   * (Mod+Enter or the send button's menu), and the empty box offers Stop. `onsent` gets the result (the
   * queued turn or the steer) so the page shows it before the stream does.
   * Pills: the model and reasoning effort for the next messages (same provider and profile as the
   * thread), sent with each message as an override for its turn; unchanged = the thread's defaults.
   * Under the box: where the thread runs (hover for the worker) and the permission mode for the next
   * messages, sent like the model as an override of their turns (the thread's default = no override; a
   * steer runs in the mode of the turn it joins).
   */
  let {
    thread,
    worker,
    running,
    disabled = false,
    note,
    onsent,
    leading,
    class: className,
  }: {
    thread: ui.Thread;
    worker: ui.Worker | undefined;
    running: boolean;
    disabled?: boolean;
    note?: string | undefined;
    onsent?: ((response: ui.SendMessageResponse) => void) | undefined;
    /** Extra controls at the start of the box's bottom row (e.g. setting a goal). */
    leading?: Snippet | undefined;
    class?: ClassValue;
  } = $props();

  // The thread's provider and profile stay; only models on them are offered. `current` = the thread's default.
  const offer = useThreadModels(() => ({ thread, worker }));
  // Your choice for this thread's next messages (kept per thread; navigating to another starts fresh).
  let choice = $state<{ threadId: string; option?: ModelOption | undefined; effort?: string | undefined }>({ threadId: "" });
  const mine = $derived(choice.threadId === thread.id ? choice : undefined);
  const option = $derived(mine?.option ?? offer.current);
  const effort = $derived(mine?.effort);
  const threadMode = $derived(permissionKey(thread.permissionMode));
  let modeChoice = $state<{ threadId: string; mode: PermissionModeKey }>();
  const mode = $derived(modeChoice?.threadId === thread.id ? modeChoice.mode : threadMode);
  const override = $derived({
    ...turnOverride(option, offer.current, effort, thread.effort),
    ...(mode !== threadMode && { permissionMode: mode }),
  });

  let text = $state("");
  let sending = $state(false);
  let stopping = $state(false);
  let error = $state<string | undefined>(undefined);
  /** What happened to the last message when it did not go the way it was sent (a steer that became a turn). */
  let outcome = $state<string | undefined>(undefined);
  // One key per message: a retry after a network error reuses it, a new message gets a new one.
  let requestId = crypto.randomUUID();

  function submit(event: SubmitEvent) {
    event.preventDefault();
    void send(running ? "steer" : "queue");
  }

  async function send(delivery: Delivery) {
    const message = text.trim();
    if (!message || sending || disabled) return;
    sending = true;
    error = undefined;
    outcome = undefined;
    try {
      const response = await sendMessage(thread.id, message, requestId, override, delivery);
      onsent?.(response);
      // Steered while the turn was ending: the gateway queued it as the next turn.
      if (delivery === "steer" && response.turn) outcome = "The turn had just ended, so your message runs as the next turn.";
      text = "";
      requestId = crypto.randomUUID();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      sending = false;
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
    bind:value={text}
    placeholder={running ? "Steer the agent, or queue for the next turn…" : "Ask anything…"}
    {disabled}
    {sending}
    {stopping}
    onstop={running ? interrupt : undefined}
    onqueue={running ? () => void send("queue") : undefined}
  >
    {#snippet controls()}
      {@render leading?.()}
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
    {/snippet}
    {#snippet meta()}
      <WorkerHoverCard {worker} />
      <PermissionPicker value={mode} inherited={threadMode} onselect={(next) => (modeChoice = { threadId: thread.id, mode: next })} class="-mr-1.5" />
    {/snippet}
  </ComposerBox>
  {#if outcome}<p class="px-3 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400" role="status">{outcome}</p>{/if}
  {#if note}<p class="px-3 text-sm/5 text-amber-700 sm:text-xs/5 dark:text-amber-400" role="status">{note}</p>{/if}
</form>

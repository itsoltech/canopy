<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { threadModelOptions, type ModelOption } from "#lib/features/models/catalog.ts";
  import { useModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import ModelControls from "#lib/features/models/ModelControls.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import WorkerHoverCard from "#lib/features/overview/WorkerHoverCard.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import PillText from "#lib/shared/ui/PillText.svelte";
  import { interruptThread, sendMessage } from "../api.ts";
  import { permissionLabel, providerLabel } from "../labels.ts";
  import { providerKeyOf } from "../providers.ts";
  import ComposerBox from "./ComposerBox.svelte";

  /**
   * Message box of a thread. Each send carries an idempotency key, so a retried send never runs
   * twice. While a turn runs, a typed message queues and the empty box offers Stop.
   * Pills: the model and reasoning effort for the next messages (same provider and profile as the
   * thread), sent with each message as an override for its turn; unchanged = the thread's defaults.
   * Under the box: where the thread runs (hover for the worker) and its permission mode
   * (fixed for the thread's life).
   */
  let {
    thread,
    worker,
    running,
    disabled = false,
    note,
    class: className,
  }: { thread: ui.Thread; worker: ui.Worker | undefined; running: boolean; disabled?: boolean; note?: string | undefined; class?: ClassValue } = $props();

  const overview = useOverview();
  const models = useModelCatalog();
  // The thread's provider and profile stay; only models on them are offered. `current` = the thread's default.
  const offer = $derived(threadModelOptions(thread, { worker, catalog: models.of(thread.workerId), threads: overview.threads.values() }));
  // Your choice for this thread's next messages (kept per thread; navigating to another starts fresh).
  let choice = $state<{ threadId: string; option?: ModelOption | undefined; effort?: string | undefined }>({ threadId: "" });
  const mine = $derived(choice.threadId === thread.id ? choice : undefined);
  const option = $derived(mine?.option ?? offer.current);
  const effort = $derived(mine?.effort);
  // The turn's override: a model other than the thread's, a chosen effort; without one the thread's effort,
  // unless the model does not take it (then the model's default).
  const override = $derived.by(() => {
    const model = option && offer.current && option.key !== offer.current.key ? option.model : undefined;
    const fallback = option && thread.effort && option.efforts.length > 0 && !option.efforts.some((e) => e.id === thread.effort) ? option.defaultEffort : undefined;
    const sent = effort ?? fallback;
    return { ...(model !== undefined && { model }), ...(sent && { effort: sent }) };
  });

  let text = $state("");
  let sending = $state(false);
  let stopping = $state(false);
  let error = $state<string | undefined>(undefined);
  // One key per message: a retry after a network error reuses it, a new message gets a new one.
  let requestId = crypto.randomUUID();

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const message = text.trim();
    if (!message || sending || disabled) return;
    sending = true;
    error = undefined;
    try {
      await sendMessage(thread.id, message, requestId, override);
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

<form class={["grid gap-2", className]} onsubmit={submit}>
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  <ComposerBox
    bind:value={text}
    placeholder={running ? "Queue a message for when this turn ends…" : "Ask anything…"}
    {disabled}
    {sending}
    {stopping}
    onstop={running ? interrupt : undefined}
  >
    {#snippet controls()}
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
      <span class="flex shrink-0 items-center gap-1.5"><Icon name="shield-check" class="size-3.5" />{permissionLabel(thread.permissionMode)}</span>
    {/snippet}
  </ComposerBox>
  {#if note}<p class="px-3 text-sm/5 text-amber-700 sm:text-xs/5 dark:text-amber-400" role="status">{note}</p>{/if}
</form>

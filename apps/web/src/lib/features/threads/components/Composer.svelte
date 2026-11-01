<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { modelOption, modelOptions, type ModelOption } from "#lib/features/models/catalog.ts";
  import ModelControls from "#lib/features/models/ModelControls.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import WorkerHoverCard from "#lib/features/overview/WorkerHoverCard.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { interruptThread, sendMessage } from "../api.ts";
  import { permissionLabel, providerLabel } from "../labels.ts";
  import { providerKeyOf } from "../providers.ts";
  import ComposerBox from "./ComposerBox.svelte";

  /**
   * Message box of a thread. Each send carries an idempotency key, so a retried send never runs
   * twice. While a turn runs, a typed message queues and the empty box offers Stop.
   * Pills: the model and reasoning effort for the next messages (same provider and profile as the
   * thread). Under the box: where the thread runs (hover for the worker) and its permission mode
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
  const provider = $derived(providerKeyOf(thread.provider));
  // The thread's provider and profile stay; only models on them are offered, the thread's own first.
  const current = $derived(provider ? modelOption(provider, thread.providerProfileId, thread.providerProfileId || "native", thread.model, "recent") : undefined);
  const options = $derived.by(() => {
    if (!provider || !current) return [];
    const offered = modelOptions({ worker, threads: overview.threads.values(), only: { provider, profileId: thread.providerProfileId } });
    return offered.some((o) => o.key === current.key) ? offered : [current, ...offered];
  });
  // PENDING backend: per-message model and effort (SendMessageRequest.model / reasoning_effort). Until
  // the contract has them the choice stays in this composer and is not sent.
  let picked = $state<ModelOption>();
  let effort = $state<string>();
  const option = $derived(picked ?? options.find((o) => o.key === current?.key));

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
      await sendMessage(thread.id, message, requestId);
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
      <span class="flex min-w-0 flex-1 items-center justify-end gap-1">
        {#if option}
          <ModelControls {options} bind:option={() => option, (next) => (picked = next)} bind:effort notice="Per-message model and effort are not sent yet: the gateway does not take them." />
        {:else}
          <span class="min-w-0 truncate px-2 text-sm/5 text-zinc-500 sm:text-[0.8125rem]/5 dark:text-zinc-400">{providerLabel(thread.provider)}</span>
        {/if}
      </span>
    {/snippet}
    {#snippet meta()}
      <WorkerHoverCard {worker} />
      <span class="flex shrink-0 items-center gap-1.5"><Icon name="shield-check" class="size-3.5" />{permissionLabel(thread.permissionMode)}</span>
    {/snippet}
  </ComposerBox>
  {#if note}<p class="px-3 text-sm/5 text-amber-700 sm:text-xs/5 dark:text-amber-400" role="status">{note}</p>{/if}
</form>

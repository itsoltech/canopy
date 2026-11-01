<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { interruptThread, sendMessage } from "../api.ts";
  import { permissionLabel, providerLabel } from "../labels.ts";
  import ComposerBox from "./ComposerBox.svelte";

  /**
   * Message box of a thread. Each send carries an idempotency key, so a retried send never runs
   * twice. While a turn runs, a typed message queues and the empty box offers Stop.
   * Under the box: where the thread runs and its permission mode (fixed for the thread's life).
   */
  let {
    thread,
    worker,
    running,
    disabled = false,
    note,
    class: className,
  }: { thread: ui.Thread; worker: ui.Worker | undefined; running: boolean; disabled?: boolean; note?: string | undefined; class?: ClassValue } = $props();

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
      <span class="min-w-0 truncate px-2 text-sm/5 text-zinc-500 sm:text-[0.8125rem]/5 dark:text-zinc-400" title="Agent of this thread">
        {providerLabel(thread.provider)}{thread.model ? ` ${thread.model}` : ""}{thread.providerProfileId ? ` · ${thread.providerProfileId}` : ""}
      </span>
    {/snippet}
    {#snippet meta()}
      <span class="flex min-w-0 items-center gap-1.5">
        <Icon name="computer-desktop" class="size-3.5" />
        <span class="truncate">{worker?.name ?? "Unknown worker"}{worker && !worker.online ? " (offline)" : ""}</span>
      </span>
      <span class="flex shrink-0 items-center gap-1.5"><Icon name="shield-check" class="size-3.5" />{permissionLabel(thread.permissionMode)}</span>
    {/snippet}
  </ComposerBox>
  {#if note}<p class="px-3 text-sm/5 text-amber-700 sm:text-xs/5 dark:text-amber-400" role="status">{note}</p>{/if}
</form>

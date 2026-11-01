<script lang="ts">
  import { interruptThread, sendMessage } from "../api.ts";

  /** Message input. Enter sends, Shift+Enter adds a line; each send carries an idempotency key. */
  let { threadId, running, disabled = false }: { threadId: string; running: boolean; disabled?: boolean } = $props();

  let text = $state("");
  let busy = $state(false);
  let error = $state<string | undefined>(undefined);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const message = text.trim();
    if (!message || busy) return;
    busy = true;
    error = undefined;
    try {
      await sendMessage(threadId, message, crypto.randomUUID());
      text = "";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function interrupt() {
    try {
      await interruptThread(threadId);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      (event.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
    }
  }
</script>

<form class="flex items-end gap-2 border-t border-slate-200 bg-white p-3" onsubmit={submit}>
  <label class="sr-only" for="composer">Message</label>
  <textarea
    id="composer"
    class="input min-h-12 flex-1 resize-y"
    rows="2"
    placeholder={running ? "The agent is working; your message will run next…" : "Message the agent…"}
    bind:value={text}
    {onkeydown}
    {disabled}
  ></textarea>
  {#if running}
    <button type="button" class="btn-danger" onclick={interrupt}>Stop</button>
  {/if}
  <button class="btn-primary" disabled={disabled || busy || !text.trim()}>Send</button>
</form>
{#if error}<p class="px-3 pb-2 text-sm text-rose-700" role="alert">{error}</p>{/if}

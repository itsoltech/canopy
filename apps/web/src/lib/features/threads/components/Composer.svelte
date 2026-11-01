<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Kbd from "#lib/shared/ui/Kbd.svelte";
  import { interruptThread, sendMessage } from "../api.ts";

  /**
   * Message input. Enter sends, Shift+Enter adds a line; each send carries an idempotency key, so a
   * retried send never runs twice. While a turn runs, new messages queue and Stop interrupts.
   * `prominent` = false demotes Send when something else on the page is the primary action.
   */
  let {
    threadId,
    running,
    disabled = false,
    note,
    prominent = true,
    class: className,
  }: { threadId: string; running: boolean; disabled?: boolean; note?: string | undefined; prominent?: boolean; class?: ClassValue } = $props();

  let text = $state("");
  let sending = $state(false);
  let stopping = $state(false);
  let error = $state<string | undefined>(undefined);
  // One key per message: a retry after a network error reuses it, a new message gets a new one.
  let requestId = crypto.randomUUID();
  const id = $props.id();

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const message = text.trim();
    if (!message || sending || disabled) return;
    sending = true;
    error = undefined;
    try {
      await sendMessage(threadId, message, requestId);
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
      await interruptThread(threadId);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      stopping = false;
    }
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      (event.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
    }
  }
</script>

<form class={["grid gap-2", className]} onsubmit={submit} aria-describedby={note ? `${id}-note` : undefined}>
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  <div
    class="rounded-xl bg-white shadow-xs ring-1 ring-zinc-950/10 has-focus-visible:ring-2 has-focus-visible:ring-sky-500 has-disabled:bg-zinc-50 dark:bg-white/5 dark:shadow-none dark:ring-white/10 dark:has-disabled:bg-white/2.5"
  >
    <label for="{id}-input" class="sr-only">Message</label>
    <textarea
      id="{id}-input"
      name="message"
      rows="1"
      class="block max-h-60 min-h-12 w-full resize-none bg-transparent px-4 pt-3 text-base/6 text-zinc-950 [field-sizing:content] placeholder:text-zinc-400 focus:outline-none disabled:cursor-not-allowed sm:text-sm/6 dark:text-white dark:placeholder:text-zinc-500"
      placeholder={running ? "Queue a message for when this turn ends…" : "Message the agent…"}
      bind:value={text}
      {onkeydown}
      {disabled}
    ></textarea>
    <div class="flex items-center justify-end gap-2 p-2 pl-4 sm:justify-between">
      <p class="text-sm/5 text-zinc-500 max-sm:sr-only sm:text-xs/5 dark:text-zinc-400"><Kbd>Enter</Kbd> to send, <Kbd>Shift</Kbd> + <Kbd>Enter</Kbd> for a new line</p>
      <div class="flex items-center gap-2">
        {#if running}
          <Button icon="stop" loading={stopping} onclick={interrupt}>Stop</Button>
        {/if}
        <Button type="submit" variant={prominent ? "primary" : "secondary"} icon="paper-airplane" loading={sending} disabled={disabled || !text.trim()}>
          {running ? "Queue" : "Send"}
        </Button>
      </div>
    </div>
  </div>
  {#if note}<p id="{id}-note" class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">{note}</p>{/if}
</form>

<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import RoundButton from "./RoundButton.svelte";

  /**
   * Message box of a bot chat: "+" for attachments, a growing text field, and the mic, which turns
   * into the send button once there is text. Enter sends, Shift+Enter adds a line. A missing
   * `onattach` / `onrecord` keeps that button visible but unavailable ("coming soon"); `disabled`
   * (with `disabledReason` as the placeholder) turns the whole box off.
   */
  let {
    value = $bindable(""),
    placeholder = "Message",
    disabled = false,
    disabledReason,
    sending = false,
    onsend,
    onattach,
    onrecord,
    class: className,
  }: {
    value?: string;
    placeholder?: string;
    disabled?: boolean;
    disabledReason?: string | undefined;
    sending?: boolean;
    onsend: (text: string) => void;
    onattach?: (() => void) | undefined;
    onrecord?: (() => void) | undefined;
    class?: ClassValue;
  } = $props();

  const id = $props.id();
  const ready = $derived(!disabled && !sending && value.trim().length > 0);

  function send() {
    if (!ready) return;
    onsend(value.trim());
    value = "";
  }
</script>

<form
  class={["flex items-end gap-2", className]}
  onsubmit={(event) => {
    event.preventDefault();
    send();
  }}
>
  <RoundButton icon="plus" label="Add attachment" tooltip={onattach ? "Add attachment" : "Attachments are coming soon"} variant="secondary" unavailable={disabled || !onattach} onclick={onattach} />
  <div
    class="flex min-w-0 flex-1 items-end gap-1 rounded-3xl bg-white py-1 pr-1 pl-4 shadow-sm ring-1 ring-zinc-950/10 has-focus-visible:ring-zinc-950/25 has-disabled:opacity-70 dark:bg-zinc-950 dark:shadow-none dark:ring-white/10 dark:has-focus-visible:ring-white/20"
  >
    <label for="{id}-message" class="sr-only">Message</label>
    <textarea
      id="{id}-message"
      name="message"
      rows="1"
      bind:value
      {disabled}
      placeholder={disabled && disabledReason ? disabledReason : placeholder}
      class="max-h-40 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-base/6 text-zinc-950 [field-sizing:content] placeholder:text-zinc-400 focus:outline-none disabled:cursor-not-allowed sm:text-sm/6 dark:text-white dark:placeholder:text-zinc-500"
      onkeydown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          send();
        }
      }}
    ></textarea>
    {#if value.trim()}
      <RoundButton type="submit" icon="arrow-up" label="Send" variant="primary" unavailable={!ready} busy={sending} />
    {:else}
      <RoundButton icon="microphone" label="Record a voice message" tooltip={onrecord ? "Record a voice message" : "Voice messages are coming soon"} unavailable={disabled || !onrecord} onclick={onrecord} />
    {/if}
  </div>
</form>

<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { iconSwap } from "#lib/shared/ui/motion.ts";
  import RoundButton from "./RoundButton.svelte";

  /**
   * Message box of a bot chat, one rounded pill: "+" on the left, the text growing up to a few lines, and
   * the send button, which appears once there is text. Enter sends and Shift+Enter adds a line; on touch
   * keyboards Enter adds a line and the button sends. A missing `onattach` keeps "+" visible but
   * unavailable ("coming soon"); `disabled` (with `disabledReason` as the placeholder) turns the box off.
   * `focus()` puts the caret at the end (after a reply quote was added).
   */
  let {
    value = $bindable(""),
    placeholder = "Message",
    disabled = false,
    disabledReason,
    sending = false,
    onsend,
    onattach,
    class: className,
  }: {
    value?: string;
    placeholder?: string;
    disabled?: boolean;
    disabledReason?: string | undefined;
    sending?: boolean;
    onsend: (text: string) => void;
    onattach?: (() => void) | undefined;
    class?: ClassValue;
  } = $props();

  const id = $props.id();
  let input = $state<HTMLTextAreaElement>();
  const ready = $derived(!disabled && !sending && value.trim().length > 0);

  export function focus() {
    input?.focus();
    input?.setSelectionRange(value.length, value.length);
  }

  function send() {
    if (!ready) return;
    onsend(value.trim());
    value = "";
  }
</script>

<form
  class={[
    "flex items-end gap-1 rounded-[1.75rem] bg-white p-1.5 shadow-sm ring-1 ring-zinc-950/10 has-focus-visible:ring-zinc-950/20 has-disabled:opacity-70 dark:bg-zinc-900 dark:shadow-none dark:ring-white/10 dark:has-focus-visible:ring-white/20",
    className,
  ]}
  onsubmit={(event) => {
    event.preventDefault();
    send();
  }}
>
  <RoundButton icon="plus" label="Add attachment" tooltip={onattach ? "Add attachment" : "Attachments are coming soon"} variant="secondary" unavailable={disabled || !onattach} onclick={onattach} />
  <label for="{id}-message" class="sr-only">Message</label>
  <textarea
    bind:this={input}
    id="{id}-message"
    name="message"
    rows="1"
    enterkeyhint="send"
    bind:value
    {disabled}
    placeholder={disabled && disabledReason ? disabledReason : placeholder}
    class="max-h-40 min-w-0 flex-1 resize-none self-center bg-transparent px-2 py-1.5 text-base/6 text-zinc-950 [field-sizing:content] placeholder:text-zinc-500 focus:outline-none disabled:cursor-not-allowed sm:text-sm/6 dark:text-white dark:placeholder:text-zinc-400"
    onkeydown={(event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !matchMedia("(pointer: coarse)").matches) {
        event.preventDefault();
        send();
      }
    }}
  ></textarea>
  {#if value.trim()}
    <span class="flex" in:iconSwap>
      <RoundButton type="submit" icon="arrow-up" label="Send" variant="primary" unavailable={!ready} busy={sending} />
    </span>
  {/if}
</form>

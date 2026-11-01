<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { matchesHotkey } from "#lib/shared/ui/hotkeys.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Kbd from "#lib/shared/ui/Kbd.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";
  import SteerSendButton from "./SteerSendButton.svelte";

  /**
   * T3-style message box: a growing textarea and a bottom row with `controls` (pills) and a round
   * send button. While `onstop` is set and the box is empty, the round button stops the turn instead.
   * Enter submits the surrounding form, Shift+Enter adds a line. `meta` renders under the box.
   * With `onqueue` (a turn runs) a typed message has two ways: submitting steers it into the running
   * turn (Enter, the "Steer" button), `onqueue` keeps it for the next turn (Mod+Enter, the button's menu).
   */
  let {
    value = $bindable(""),
    name = "message",
    label = "Message",
    placeholder = "Ask anything…",
    disabled = false,
    sending = false,
    stopping = false,
    autofocus = false,
    onstop,
    onqueue,
    controls,
    meta,
    class: className,
  }: {
    value?: string;
    name?: string;
    label?: string;
    placeholder?: string;
    disabled?: boolean;
    sending?: boolean;
    stopping?: boolean;
    autofocus?: boolean;
    onstop?: (() => void) | undefined;
    onqueue?: (() => void) | undefined;
    controls?: Snippet;
    meta?: Snippet;
    class?: ClassValue;
  } = $props();

  const id = $props.id();
  const stopMode = $derived(Boolean(onstop) && !value.trim());
  const steerMode = $derived(Boolean(onqueue) && !stopMode && Boolean(value.trim()));
  let textarea = $state<HTMLTextAreaElement>();
  const submit = () => textarea?.form?.requestSubmit();

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!value.trim()) return;
      if (onqueue && matchesHotkey(event, "Mod+Enter")) onqueue();
      else submit();
    }
  }
  function focusOnMount(node: HTMLTextAreaElement) {
    if (autofocus) node.focus();
  }
</script>

<div class={["grid grid-cols-1 gap-2", className]}>
  <div
    class="rounded-2xl bg-white shadow-sm ring-1 ring-zinc-950/10 has-focus-visible:ring-zinc-950/25 has-disabled:opacity-70 dark:bg-zinc-950 dark:shadow-none dark:ring-white/10 dark:has-focus-visible:ring-white/20"
  >
    <label for="{id}-input" class="sr-only">{label}</label>
    <textarea
      id="{id}-input"
      {name}
      rows="2"
      class="block max-h-72 min-h-16 w-full resize-none bg-transparent px-4 pt-3.5 text-base/6 text-zinc-950 [field-sizing:content] placeholder:text-zinc-400 focus:outline-none disabled:cursor-not-allowed dark:text-white dark:placeholder:text-zinc-500"
      {placeholder}
      bind:value
      {onkeydown}
      {disabled}
      bind:this={textarea}
      aria-keyshortcuts={onqueue ? "Enter Control+Enter Meta+Enter" : undefined}
      {@attach focusOnMount}
    ></textarea>
    <div class="flex items-center justify-end gap-2 p-2.5 pl-3">
      {#if steerMode}
        <p class="flex shrink-0 items-center gap-1.5 text-xs/5 text-zinc-500 max-sm:hidden pointer-coarse:hidden dark:text-zinc-400" aria-hidden="true">
          <Kbd hotkey="Enter" />steer<Kbd hotkey="Mod+Enter" class="ml-1" />queue
        </p>
      {/if}
      {@render controls?.()}
      {#if steerMode && onqueue}
        <SteerSendButton {sending} disabled={disabled || !value.trim()} onsteer={submit} {onqueue} />
      {:else if stopMode}
        <button
          type="button"
          class="relative grid size-9 shrink-0 place-items-center rounded-full bg-zinc-950 text-white focus-ring disabled:opacity-50 sm:size-8 dark:bg-white dark:text-zinc-950"
          aria-label="Stop the turn"
          {@attach tooltip("Stop the turn")}
          disabled={stopping}
          onclick={onstop}
        >
          {#if stopping}<Spinner class="size-3.5" />{:else}<Icon name="stop" class="size-3.5" />{/if}
          <TouchTarget />
        </button>
      {:else}
        <button
          type="submit"
          class="relative grid size-9 shrink-0 place-items-center rounded-full bg-brand-600 text-white focus-ring not-disabled:hover:bg-brand-500 disabled:bg-zinc-950/10 disabled:text-zinc-400 sm:size-8 dark:disabled:bg-white/10 dark:disabled:text-zinc-500"
          aria-label="Send"
          {@attach tooltip("Send", { hotkey: "Enter" })}
          disabled={disabled || sending || !value.trim()}
        >
          {#if sending}<Spinner class="size-3.5" />{:else}<Icon name="arrow-up" />{/if}
          <TouchTarget />
        </button>
      {/if}
    </div>
  </div>
  {#if meta}
    <div class="flex min-w-0 items-center justify-between gap-3 px-3 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">{@render meta()}</div>
  {/if}
</div>

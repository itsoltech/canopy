<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { create } from "@bufbuild/protobuf";
  import { MentionKind, ui, type Mention } from "@open-agents/contracts";
  import MentionEditor from "#lib/features/mentions/MentionEditor.svelte";
  import { trimValue, type TriggerChar } from "#lib/features/mentions/editor.ts";
  import { kindLook, safeIcon } from "#lib/features/mentions/kinds.ts";
  import { botList } from "../bot-list.svelte.ts";
  import { BOT_MENTION_TRIGGERS, BotMentionSources } from "../mention-sources.svelte.ts";
  import { iconSwap } from "#lib/shared/ui/motion.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import BotAvatar from "./BotAvatar.svelte";
  import QuoteTray from "#lib/features/quotes/QuoteTray.svelte";
  import { toWire, useQuoteDrafts } from "#lib/features/quotes/quote-drafts.svelte.ts";
  import RoundButton from "./RoundButton.svelte";

  /**
   * Message box of a bot chat, one rounded pill: "+" on the left, the text growing up to a few lines, and
   * the send button, which appears once there is text or a quote. Shared MentionEditor and QuoteTray own
   * rich text, atomic bot chips and removable quote drafts. Enter sends and Shift+Enter adds a line; on touch
   * keyboards Enter adds a line and the button sends. A missing `onattach` keeps "+" visible but
   * unavailable ("coming soon"); `disabled` (with `disabledReason` as the placeholder) turns the box off.
   * `focus()` returns to the text after adding a reply quote without changing the draft.
   */
  let {
    value = $bindable(""),
    mentions = $bindable([]),
    botId,
    quoteKey,
    placeholder = "Message",
    disabled = false,
    disabledReason,
    sending = false,
    onsend,
    onattach,
    class: className,
  }: {
    value?: string;
    mentions?: Mention[];
    botId: string;
    quoteKey: string;
    placeholder?: string;
    disabled?: boolean;
    disabledReason?: string | undefined;
    sending?: boolean;
    onsend: (text: string, mentions: Mention[], quotes: ui.Quote[]) => void;
    onattach?: (() => void) | undefined;
    class?: ClassValue;
  } = $props();

  const id = $props.id();
  let box = $state<HTMLDivElement>();
  let editor = $state<{ insertTrigger(char: TriggerChar): void; focus(): void }>();
  const sources = new BotMentionSources(() => botList.list, () => botId);
  const quoteDrafts = useQuoteDrafts();
  const quotes = $derived(quoteDrafts.list(quoteKey));
  const ready = $derived(!disabled && !sending && (value.trim().length > 0 || quotes.length > 0));
  let multiline = $state(false);
  $effect(() => {
    const field = box?.querySelector<HTMLElement>('[role="textbox"]');
    if (!field) return;
    const observer = new ResizeObserver(() => { multiline = field.scrollHeight > 42; });
    observer.observe(field);
    return () => observer.disconnect();
  });

  export function focus() {
    editor?.focus();
  }

  function send() {
    if (!ready) return;
    const trimmed = trimValue({ text: value, mentions });
    onsend(trimmed.text, trimmed.mentions, quotes.map((quote) => create(ui.QuoteSchema, toWire(quote))));
    for (const quote of quotes) quoteDrafts.remove(quoteKey, quote.id);
    value = "";
    mentions = [];
  }
</script>

<div
  bind:this={box}
  role="group"
  aria-label="Message composer"
  data-expanded={multiline || quotes.length > 0 || undefined}
  class={[
    "grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-x-1 rounded-[1.75rem] bg-white p-1.5 shadow-sm ring-1 ring-zinc-950/10 transition-[border-radius] duration-(--duration-fast) ease-(--ease-smooth-out) has-focus-visible:ring-zinc-950/20 data-expanded:rounded-2xl motion-reduce:transition-none dark:bg-zinc-900 dark:shadow-none dark:ring-white/10 dark:has-focus-visible:ring-white/20",
    disabled && "opacity-70",
    className,
  ]}
>
  {#if quotes.length > 0}
    <div class="col-span-3 row-start-1 min-w-0 px-2 pt-2 pb-3"><QuoteTray threadId={quoteKey} /></div>
  {/if}
  <div class="col-start-1 row-start-3 flex">
    <RoundButton icon="plus" label="Add attachment" tooltip={onattach ? "Add attachment" : "Attachments are coming soon"} variant="secondary" unavailable={disabled || !onattach} onclick={onattach} />
  </div>
  <MentionEditor
    id="{id}-message"
    label="Message"
    bind:value
    bind:mentions
    bind:editor
    {disabled}
    {sources}
    triggers={BOT_MENTION_TRIGGERS}
    anchor={box}
    containerClass="col-start-2 row-start-3 self-center"
    suggestionsClass="col-span-3 row-start-2 min-w-0 overflow-hidden rounded-t-3xl"
    placeholder={disabled && disabledReason ? disabledReason : placeholder}
    class={["max-h-[min(40dvh,16rem)] min-h-9 overflow-y-auto overscroll-contain px-2 py-1.5 text-base/6 sm:min-h-8 sm:text-sm/6", disabled && "cursor-not-allowed"]}
    onkeydown={(event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !matchMedia("(pointer: coarse)").matches) {
        event.preventDefault();
        send();
      }
    }}
  >
    {#snippet optionIcon(option)}
      {#if option.data.kind === MentionKind.BOT}
        <BotAvatar participant={sources.participant(option.data.name, option.title)} size="xs" />
      {:else if safeIcon(option.data.icon)}
        <img src={safeIcon(option.data.icon)} alt="" class="size-4 rounded-sm object-contain" />
      {:else}
        <Icon name={kindLook(option.data).icon} />
      {/if}
    {/snippet}
  </MentionEditor>
  {#if value.trim() || quotes.length > 0}
    <span class="col-start-3 row-start-3 flex" in:iconSwap>
      <RoundButton icon="arrow-up" label="Send" variant="primary" unavailable={!ready} busy={sending} onclick={send} />
    </span>
  {/if}
</div>

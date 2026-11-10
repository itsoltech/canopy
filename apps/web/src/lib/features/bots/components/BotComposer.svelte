<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { create } from "@bufbuild/protobuf";
  import { MentionKind, ui, type Mention } from "@canopy/contracts";
  import { fuzzyRank } from "@canopy/domain";
  import { splitId } from "@canopy/domain/computers";
  import { connectorLabel } from "#lib/features/connectors/api.ts";
  import { useConnectorAccounts } from "#lib/features/connectors/accounts.svelte.ts";
  import ConnectorIcon from "#lib/features/connectors/ConnectorIcon.svelte";
  import MentionEditor from "#lib/features/mentions/MentionEditor.svelte";
  import { trimValue, type EditorControls, type TriggerChar } from "#lib/features/mentions/editor.ts";
  import { kindLook, safeIcon } from "#lib/features/mentions/kinds.ts";
  import { botList } from "../bot-list.svelte.ts";
  import { BOT_MENTION_TRIGGERS, BotMentionSources } from "../mention-sources.svelte.ts";
  import { iconSwap } from "#lib/shared/ui/motion.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import BotAvatar from "./BotAvatar.svelte";
  import QuoteTray from "#lib/features/quotes/QuoteTray.svelte";
  import { toWire, useQuoteDrafts } from "#lib/features/quotes/quote-drafts.svelte.ts";
  import RoundButton from "./RoundButton.svelte";
  import type { AttachmentDraft } from "#lib/features/attachments/draft.svelte.ts";
  import BotImageIntake from "./BotImageIntake.svelte";

  /**
   * Message box of a bot chat, one rounded pill: "+" on the left, the text growing up to a few lines, and
   * the send button, which appears once there is text or a quote. Shared MentionEditor and QuoteTray own
   * rich text, atomic bot chips and removable quote drafts. Enter sends and Shift+Enter adds a line; on touch
   * keyboards Enter adds a line and the button sends. The shared intake uploads pasted, dropped or picked images.
   * `disabled` (with `disabledReason` as the placeholder) turns the box off.
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
    running = false,
    stopping = false,
    onstop,
    onsend,
    onattach,
    files,
    durable = false,
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
    running?: boolean;
    stopping?: boolean;
    onstop?: (() => void) | undefined;
    onsend: (text: string, mentions: Mention[], quotes: ui.Quote[]) => void;
    onattach?: (() => void) | undefined;
    files?: AttachmentDraft | undefined;
    durable?: boolean;
    class?: ClassValue;
  } = $props();

  const id = $props.id();
  let box = $state<HTMLDivElement>();
  let editor = $state<EditorControls>();
  let intake = $state<ReturnType<typeof BotImageIntake>>();
  const connectorCatalog = useConnectorAccounts(() => (splitId(botId).node ? undefined : { botId }));

  const sources = new BotMentionSources(
    () => botList.list,
    () => botId,
    [
      {
        search: (query) =>
          fuzzyRank(
            query,
            connectorCatalog.accounts.filter((a) => a.status === "connected"),
            (a) => [connectorLabel(a, connectorCatalog.types)],
            40,
          ).map(({ item, match }) => ({
            key: `connector:${item.id}`,
            data: {
              kind: MentionKind.CONNECTOR,
              name: item.id,
              label: connectorLabel(item, connectorCatalog.types),
              source: item.connectorType,
              path: "",
              isDir: false,
            },
            title: connectorLabel(item, connectorCatalog.types),
            detail: "Use this connector account",
            group: "Connectors",
            indices: match.indices,
          })),
      },
    ],
  );

  const quoteDrafts = useQuoteDrafts();
  const quotes = $derived(quoteDrafts.list(quoteKey));

  const ready = $derived(
    !disabled && !sending && !files?.blocker && (value.trim().length > 0 || quotes.length > 0 || files?.ready),
  );

  let multiline = $state(false);

  $effect(() => {
    const field = box?.querySelector<HTMLElement>('[role="textbox"]');

    if (!field) return;

    const observer = new ResizeObserver(() => {
      multiline = field.scrollHeight > 42;
    });

    observer.observe(field);

    return () => observer.disconnect();
  });

  export function focus() {
    editor?.focus();
  }

  function send() {
    if (!ready || running) return;
    const trimmed = trimValue({ text: value, mentions });
    onsend(
      trimmed.text,
      trimmed.mentions,
      quotes.map((quote) => create(ui.QuoteSchema, toWire(quote))),
    );

    if (!durable) {
      for (const quote of quotes) quoteDrafts.remove(quoteKey, quote.id);
      value = "";
      mentions = [];
    }
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
  {#if files?.notice || files?.blocker}<p
      role="status"
      class="col-span-3 row-start-4 px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400"
    >
      {files.notice ?? files.blocker}
    </p>{/if}
  <div class="col-start-1 row-start-3 flex">
    <RoundButton
      icon="plus"
      label="Attach images"
      tooltip={files || onattach ? "Attach images" : "Attachments are coming soon"}
      variant="secondary"
      unavailable={disabled || sending || (!files && !onattach)}
      onclick={files ? () => intake?.pick() : onattach}
    />
  </div>
  <MentionEditor
    id="{id}-message"
    label="Message"
    bind:value
    bind:mentions
    bind:editor
    disabled={disabled || sending}
    onpaste={(event) => intake?.paste(event)}
    acceptChip={(m) => m.kind !== MentionKind.ATTACHMENT || Boolean(files?.file(m.name))}
    {sources}
    triggers={BOT_MENTION_TRIGGERS}
    anchor={box}
    containerClass="col-start-2 row-start-3 self-center"
    suggestionsClass="col-span-3 row-start-2 min-w-0 overflow-hidden rounded-t-3xl"
    placeholder={disabled && disabledReason ? disabledReason : placeholder}
    class={[
      "max-h-[min(40dvh,16rem)] min-h-9 overflow-y-auto overscroll-contain px-2 py-1.5 text-base/6 sm:min-h-8 sm:text-sm/6",
      disabled && "cursor-not-allowed",
    ]}
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
      {:else if option.data.kind === MentionKind.CONNECTOR}
        <ConnectorIcon type={option.data.source} />
      {:else if safeIcon(option.data.icon)}
        <img src={safeIcon(option.data.icon)} alt="" class="size-4 rounded-sm object-contain" />
      {:else}
        <Icon name={kindLook(option.data).icon} />
      {/if}
    {/snippet}
  </MentionEditor>
  {#if running || value.trim() || quotes.length > 0 || files?.attached.length}
    <span class="col-start-3 row-start-3 flex" in:iconSwap>
      {#if running}
        <RoundButton
          icon="stop"
          label="Stop reply"
          variant="primary"
          unavailable={!onstop}
          busy={stopping}
          onclick={onstop}
        />
      {:else}
        <RoundButton
          icon="arrow-up"
          label="Send"
          variant="primary"
          unavailable={!ready}
          busy={sending}
          onclick={send}
        />
      {/if}
    </span>
  {/if}
</div>
{#if files}<BotImageIntake
    bind:this={intake}
    draft={files}
    {editor}
    root={box}
    disabled={disabled || sending}
    {value}
    {mentions}
  />{/if}

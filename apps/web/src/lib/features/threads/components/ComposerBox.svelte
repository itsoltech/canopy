<script lang="ts">
  import type { Snippet } from "svelte";
  import type { Attachment } from "svelte/attachments";
  import type { ClassValue } from "svelte/elements";
  import { matchesHotkey } from "#lib/shared/ui/hotkeys.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Kbd from "#lib/shared/ui/Kbd.svelte";
  import { rise } from "#lib/shared/ui/motion.ts";
  import ResizeSlot from "#lib/shared/ui/ResizeSlot.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";
  import DisabledControlHint from "#lib/shared/ui/DisabledControlHint.svelte";
  import HintIcon from "#lib/shared/ui/HintIcon.svelte";
  import type { Mention } from "@canopy/contracts";
  import { filesOf, type AttachmentDraft } from "#lib/features/attachments/draft.svelte.ts";
  import DraftTray from "#lib/features/attachments/DraftTray.svelte";
  import ComposerPlusMenu from "#lib/features/mentions/ComposerPlusMenu.svelte";
  import { trimValue, type TriggerChar } from "#lib/features/mentions/editor.ts";
  import MentionEditor from "#lib/features/mentions/MentionEditor.svelte";
  import type { MentionSources } from "#lib/features/mentions/sources.svelte.ts";
  import { mentionsToWire } from "#lib/features/mentions/wire.ts";
  import SteerSendButton from "./SteerSendButton.svelte";
  import ComposerFold from "./ComposerFold.svelte";
  import type { ComposerActivity } from "./composer-compaction.ts";

  /**
   * T3-style message box: a growing text field and a bottom row with `controls` (pills) and a round
   * send button. While `onstop` is set and the box is empty, the round button stops the turn instead.
   * Enter submits the surrounding form, Shift+Enter adds a line. `meta` renders under the box.
   * With `onqueue` (a turn runs) a typed message has two ways: submitting steers it into the running
   * turn (Enter, the "Steer" button), `onqueue` keeps it for the next turn (Mod+Enter, the button's menu).
   * With `primary = "queue"` (queueing on) the two swap: Enter queues, Mod+Enter (`onalternate`) steers.
   * `canSend = false` keeps the box editable but holds the message (say why next to it); `disabled` locks both.
   * The send slot eases to the width of what it holds (send, stop, steer), so the pills glide aside.
   * Attachments (`draft`): files dropped on the box or pasted into it (screenshots from the clipboard) or picked
   * from the "+" menu, their tray above the text; with files a message may go without text.
   * Mentions (`sources`, docs/ui-api.md "Wzmianki"): the text field takes "/", "$", "@" and "#" chips
   * (MentionEditor); `mentions` are their ranges in `value`. The "+" menu offers the same triggers.
   * In a form, `name` submits the trimmed text and `mentions` (protobuf JSON) for a plain form post.
   * Block-level elements of the draft (attachments; quotes) render above the text: `elements` goes there, and
   * `elementCount` says how many it holds — with any, a message may go without text (and steer).
   */
  let {
    value = $bindable(""),
    mentions = $bindable([]),
    name = "message",
    label = "Message",
    placeholder = "Ask anything…",
    disabled = false,
    canSend = true,
    blockedReason,
    deliveryNotice,
    sending = false,
    stopping = false,
    autofocus = false,
    onstop,
    onqueue,
    primary = "steer",
    onalternate,
    controls,
    meta,
    draft,
    sources,
    elements,
    elementCount = 0,
    allowEmpty = false,
    sendLabel = "Send",
    secret = false,
    compact = false,
    panelsLabel,
    onexpand,
    ongoal,
    class: className,
  }: {
    value?: string;
    mentions?: Mention[];
    name?: string;
    label?: string;
    placeholder?: string;
    disabled?: boolean;
    canSend?: boolean;
    blockedReason?: string | undefined;
    deliveryNotice?: string | undefined;
    sending?: boolean;
    stopping?: boolean;
    autofocus?: boolean;
    onstop?: (() => void) | undefined;
    onqueue?: (() => void) | undefined;
    /** What Enter does while a turn runs (submitting the form); Mod+Enter does the other (`onqueue` / `onalternate`). */
    primary?: "steer" | "queue";
    /** Queueing on: steer the message (Mod+Enter, the button's menu). */
    onalternate?: (() => void) | undefined;
    controls?: Snippet;
    meta?: Snippet;
    draft?: AttachmentDraft | undefined;
    sources?: MentionSources | undefined;
    elements?: Snippet;
    elementCount?: number;
    allowEmpty?: boolean;
    sendLabel?: string;
    secret?: boolean;
    compact?: boolean;
    panelsLabel?: string | undefined;
    onexpand?: ((activity?: ComposerActivity) => void) | undefined;
    /** "Set a goal" in the "+" menu. */
    ongoal?: (() => void) | undefined;
    class?: ClassValue;
  } = $props();

  const triggers: ReadonlySet<TriggerChar> = new Set(["/", "$", "@", "#"]);
  const trimmed = $derived(trimValue({ text: value, mentions }));

  const id = $props.id();
  const hasFiles = $derived((draft?.files.length ?? 0) > 0);
  const hasContent = $derived(Boolean(value.trim()) || hasFiles || elementCount > 0 || allowEmpty);

  const sendBlocker = $derived(
    blockedReason ??
      draft?.blocker ??
      (disabled
        ? "Messaging is unavailable for this thread."
        : !canSend
          ? "Sending is unavailable."
          : !hasContent
            ? "Write a message or add an attachment to send."
            : undefined),
  );

  const onfiles = $derived(draft ? (files: File[]) => draft.add(files) : undefined);
  const stopMode = $derived(Boolean(onstop) && !hasContent);

  // Files go with the next turn: a message with them is never steered.
  const steerMode = $derived(Boolean(onqueue) && !stopMode && (Boolean(value.trim()) || elementCount > 0) && !hasFiles);
  let dragging = $state(false);
  const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;

  function ondrop(event: DragEvent) {
    dragging = false;

    if (!onfiles || !carriesFiles(event)) return;
    event.preventDefault();
    onexpand?.("drop");
    onfiles(filesOf(event.dataTransfer));
  }

  function onpaste(event: ClipboardEvent) {
    onexpand?.("paste");
    const files = filesOf(event.clipboardData);

    if (!onfiles || files.length === 0) return;

    // A screenshot comes without text: nothing else to paste. Text with files (an office copy) pastes as well.
    if (!event.clipboardData?.types.includes("text/plain")) event.preventDefault();
    onfiles(files);
  }

  let box = $state<HTMLDivElement>();
  let sendWidth = $state(36);

  // From its observer, after layout: `bind:clientWidth` also reads the width as it mounts, which forces a
  // layout of the whole page in the middle of rendering it (the observer still reports before the first paint).
  const followSendWidth: Attachment<HTMLElement> = (node) => {
    const observer = new ResizeObserver(() => (sendWidth = node.clientWidth));
    observer.observe(node);

    return () => observer.disconnect();
  };

  let editor = $state<{ insertTrigger(char: TriggerChar): void; focus(): void }>();
  const submit = () => box?.closest("form")?.requestSubmit();

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();

      if (sendBlocker || sending) return;

      if (onqueue && matchesHotkey(event, "Mod+Enter")) (primary === "queue" ? (onalternate ?? onqueue) : onqueue)();
      else submit();
    }
  }
</script>

<div class={["grid grid-cols-1", className]}>
  <div
    class={[
      "relative rounded-2xl bg-surface shadow-sm ring-1 has-focus-visible:ring-accent dark:shadow-none",
      disabled && "opacity-70",
      dragging ? "ring-2 ring-brand-600 dark:ring-brand-500" : "ring-zinc-950/10 dark:ring-white/10",
    ]}
    bind:this={box}
    onbeforeinput={() => onexpand?.("typing")}
    onpointerdown={() => onexpand?.("pointer")}
    data-compact={compact || undefined}
    style:--composer-send-width="{sendWidth}px"
    role="group"
    aria-label={onfiles ? `${label}, drop files to attach` : undefined}
    ondragover={(event) => {
      if (!onfiles || !carriesFiles(event)) return;
      event.preventDefault();
      dragging = true;
      onexpand?.("drop");
    }}
    ondragleave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) dragging = false;
    }}
    {ondrop}
  >
    <ComposerFold open={!compact}>
      {#if draft}<DraftTray {draft} class="px-3 pt-3" />{/if}
      {@render elements?.()}
    </ComposerFold>
    <div class={secret ? undefined : "t-composer-editor"}>
      {#if secret}
        <label for="{id}-secret" class="sr-only">{label}</label>
        <Input
          id="{id}-secret"
          type="password"
          bare
          bind:value
          {placeholder}
          {disabled}
          {onkeydown}
          autocomplete="off"
          class="px-4 pt-3.5 pb-4 text-base/6 sm:text-sm/6"
        />
      {:else}
        <MentionEditor
          id="{id}-input"
          {label}
          bind:value
          bind:mentions
          bind:editor
          {placeholder}
          {disabled}
          {autofocus}
          {sources}
          {triggers}
          anchor={box}
          {onkeydown}
          {onpaste}
          singleLine={compact}
          class={["text-base/6 sm:text-sm/6", disabled && "cursor-not-allowed"]}
        />
      {/if}
    </div>
    <input type="hidden" {name} value={trimmed.text} />
    {#if trimmed.mentions.length > 0}<input
        type="hidden"
        name="mentions"
        value={JSON.stringify(mentionsToWire(trimmed.mentions))}
      />{/if}
    <ComposerFold open={!compact}>
      <div
        class="flex min-h-13 items-center justify-end gap-2 p-2.5 pr-[calc(var(--composer-send-width)+--spacing(5))] pl-3"
      >
        {#if steerMode}
          <p
            class="flex shrink-0 items-center gap-1.5 text-xs/5 text-zinc-500 max-sm:hidden dark:text-zinc-400 pointer-coarse:hidden"
            aria-hidden="true"
            in:rise
          >
            <Kbd hotkey="Enter" />{primary}<Kbd hotkey="Mod+Enter" class="ml-1" />{primary === "queue"
              ? "steer"
              : "queue"}
          </p>
        {/if}
        {#if onfiles || sources || ongoal}
          <ComposerPlusMenu
            {onfiles}
            {ongoal}
            {triggers}
            {disabled}
            ontrigger={sources ? (char) => editor?.insertTrigger(char) : undefined}
          />
        {/if}
        {#if draft?.notice || draft?.blocker}
          <HintIcon
            label="Attachment information"
            text={draft.notice ?? draft.blocker ?? ""}
            warning={Boolean(draft.notice)}
          />
        {/if}
        {@render controls?.()}
      </div>
    </ComposerFold>
    <div class="absolute right-2.5 bottom-2.5 flex items-center gap-1" {@attach followSendWidth}>
      {#if deliveryNotice}<HintIcon label="Message delivery information" text={deliveryNotice} />{/if}
      <ResizeSlot>
        {#if steerMode && onqueue}
          <DisabledControlHint reason={sendBlocker}>
            <SteerSendButton
              {sending}
              {primary}
              disabled={Boolean(sendBlocker)}
              onsteer={primary === "queue" ? (onalternate ?? submit) : submit}
              onqueue={primary === "queue" ? submit : onqueue}
            />
          </DisabledControlHint>
        {:else if stopMode}
          <button
            type="button"
            class="relative grid size-9 shrink-0 place-items-center rounded-full bg-zinc-950 text-white focus-ring disabled:opacity-50 sm:size-8 dark:bg-white dark:text-zinc-950"
            aria-label="Stop the turn"
            {@attach tooltip("Stop the turn")}
            disabled={stopping}
            onclick={onstop}
          >
            {#if stopping}<Spinner class="size-3.5" />{:else}<Icon name="stop" tone="inherit" class="size-3.5" />{/if}
            <TouchTarget />
          </button>
        {:else}
          <DisabledControlHint reason={sendBlocker}>
            <button
              type="submit"
              class="relative grid size-9 shrink-0 place-items-center rounded-full bg-action text-on-accent focus-ring not-disabled:hover:bg-action-hover disabled:bg-zinc-950/10 disabled:text-zinc-400 sm:size-8 dark:disabled:bg-white/10 dark:disabled:text-zinc-500"
              aria-label={sendLabel}
              {@attach tooltip(sendLabel, { hotkey: "Enter" })}
              disabled={Boolean(sendBlocker) || sending}
            >
              {#if sending}<Spinner class="size-3.5" />{:else}<Icon
                  name={sendLabel === "Submit" ? "check" : "arrow-up"}
                  tone="inherit"
                />{/if}
              <TouchTarget />
            </button>
          </DisabledControlHint>
        {/if}
      </ResizeSlot>
    </div>
  </div>
  {#if meta}
    <ComposerFold open={!compact}>
      <div class="min-w-0 px-1 pt-2 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
        {@render meta()}
      </div>
    </ComposerFold>
  {/if}
</div>

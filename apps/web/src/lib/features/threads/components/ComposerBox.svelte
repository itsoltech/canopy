<script lang="ts">
  import type { Snippet } from "svelte";
  import type { Attachment } from "svelte/attachments";
  import type { ClassValue } from "svelte/elements";
  import { keybindings } from "#lib/features/commands/keybindings.svelte.ts";
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
  import { MentionKind, type Mention } from "@canopy/contracts";
  import { filesOf, type AttachmentDraft } from "#lib/features/attachments/draft.svelte.ts";
  import { pastedFiles, UNREACHABLE_FILES } from "#lib/features/attachments/clipboard.ts";
  import { useFileIntake } from "#lib/features/attachments/file-intake.svelte.ts";
  import EditorAttachmentPreview from "#lib/features/attachments/EditorAttachmentPreview.svelte";
  import { chipOf, showUploads } from "#lib/features/attachments/inline-chip.ts";
  import ComposerPlusMenu from "#lib/features/mentions/ComposerPlusMenu.svelte";
  import { trimValue, type EditorControls, type TriggerChar } from "#lib/features/mentions/editor.ts";
  import type { MentionData } from "#lib/features/mentions/kinds.ts";
  import MentionEditor from "#lib/features/mentions/MentionEditor.svelte";
  import type { MentionSources } from "#lib/features/mentions/sources.svelte.ts";
  import { mentionsToWire } from "#lib/features/mentions/wire.ts";
  import SteerSendButton from "./SteerSendButton.svelte";
  import ComposerFold from "./ComposerFold.svelte";
  import type { ComposerActivity } from "./composer-compaction.ts";
  import { tick } from "svelte";
  import type { github } from "@canopy/contracts";

  export async function acceptContext(context: github.PullRequestContextResponse) {
    if (!draft || !context.attachment) return;
    const file = draft.accept(context.attachment, context.scope);

    if (context.prompt) value = `${value}${value ? "\n\n" : ""}${context.prompt}`;
    await tick();
    editor?.insertChips([chipOf(file)]);
    editor?.focus();
  }

  /**
   * Message box: a growing text field and a bottom row with `controls` (pills) and a round
   * send button. While `onstop` is set and the box is empty, the round button stops the turn instead.
   * Enter submits the surrounding form, Shift+Enter adds a line. `meta` renders under the box.
   * With `onqueue` (a turn runs) a typed message has two ways: submitting steers it into the running
   * turn (Enter, the "Steer" button), `onqueue` keeps it for the next turn (Mod+Enter, the button's menu).
   * With `primary = "queue"` (queueing on) the two swap: Enter queues, Mod+Enter (`onalternate`) steers.
   * `canSend = false` keeps the box editable but holds the message (say why next to it); `disabled` locks both.
   * The send slot eases to the width of what it holds (send, stop, steer), so the pills glide aside.
   * Attachments (`draft`): files dropped on the box or pasted into it (screenshots, copied images, files copied in a
   * file manager), pasted anywhere in the window or dropped on it (`FileIntake`) or picked from the "+" menu become badges in the text at the caret (docs/ui-api.md, "Załączniki w tekście"); each badge
   * shows its upload, a tap previews it (an image in the Lightbox, a file's card), and a file goes with its badge.
   * With files a message may go without text.
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
    shell = false,
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
    /** Owner thread composers only; bots and other text inputs keep their existing semantics. */
    shell?: boolean;
    compact?: boolean;
    panelsLabel?: string | undefined;
    onexpand?: ((activity?: ComposerActivity) => void) | undefined;
    /** "Set a goal" in the "+" menu. */
    ongoal?: (() => void) | undefined;
    class?: ClassValue;
  } = $props();

  const TRIGGER_HINT = ["/ commands", "$ skills", "@ files", "# threads", "! shell"];
  const shellMode = $derived(shell && value.startsWith("!"));
  const triggers: ReadonlySet<TriggerChar> = $derived(new Set(shellMode ? [] : ["/", "$", "@", "#"]));
  const trimmed = $derived(trimValue({ text: value, mentions }));

  // The empty composer lists what each trigger character does.
  const hint = $derived(shell && sources && !compact ? TRIGGER_HINT : undefined);

  const id = $props.id();
  const hasFiles = $derived((draft?.attached.length ?? 0) > 0);

  const hasContent = $derived(
    (shellMode ? Boolean(value.slice(1).trim()) : Boolean(value.trim())) || hasFiles || elementCount > 0 || allowEmpty,
  );

  // A shell command goes alone: its badges (files, mentions) and quotes hold it, the hint by "+" says why.
  const shellBlocker = $derived(
    shellMode && (hasFiles || elementCount > 0 || mentions.length > 0)
      ? "Remove attachments, quotes and mentions to send a shell command."
      : undefined,
  );

  const sendBlocker = $derived(
    blockedReason ??
      shellBlocker ??
      draft?.blocker ??
      (disabled
        ? "Messaging is unavailable for this thread."
        : !canSend
          ? "Sending is unavailable."
          : !hasContent
            ? "Write a message or add an attachment to send."
            : undefined),
  );

  /** Files become badges at the caret (`point`: where they were dropped). */
  const onfiles = $derived(
    draft
      ? (files: File[], point?: { x: number; y: number }) => editor?.insertChips(draft.add(files).map(chipOf), point)
      : undefined,
  );

  // A file goes with its badge: the draft follows the badges the text holds.
  $effect(() => draft?.place(mentions));

  // Each badge shows its file's upload; again after the text is rendered anew.
  $effect(() => {
    void value;
    void mentions;
    const states = draft?.files.map((f) => `${f.key}:${f.status}:${f.progress}`).join("|");
    const root = editor?.root;

    if (draft && root && states !== undefined) showUploads(root, (key) => draft.file(key));
  });

  /** A paste brings back only badges of files this draft has. */
  const acceptChip = (m: MentionData) => m.kind !== MentionKind.ATTACHMENT || Boolean(draft?.file(m.name));

  const stopMode = $derived(Boolean(onstop) && !hasContent);

  const steerMode = $derived(Boolean(onqueue) && !stopMode && hasContent);
  let dragging = $state(false);
  const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;

  function ondrop(event: DragEvent) {
    dragging = false;

    if (!onfiles || !carriesFiles(event)) return;
    event.preventDefault();
    onexpand?.("drop");
    onfiles(filesOf(event.dataTransfer), { x: event.clientX, y: event.clientY });
  }

  function onpaste(event: ClipboardEvent) {
    onexpand?.("paste");

    if (!onfiles || !draft) return;
    const pasted = pastedFiles(event.clipboardData);

    if (pasted.unreachable) draft.notice = UNREACHABLE_FILES;

    // A screenshot or a file manager's copy brings only files. Text with files (an office copy) pastes as well.
    if (!pasted.text) event.preventDefault();

    if (pasted.files.length > 0) onfiles(pasted.files);
  }

  // Files pasted or dropped elsewhere in the window come here.
  const intake = useFileIntake();

  $effect(() => {
    const take = onfiles;
    const files = draft;
    const root = box;

    if (!intake || !take || !files || !root || disabled) return;

    return intake.register({
      root,
      files: (list, how) => {
        onexpand?.(how);
        take(list);
      },
      notice: (text) => (files.notice = text),
    });
  });

  let box = $state<HTMLDivElement>();
  let sendWidth = $state<number>();

  // From its observer, after layout: `bind:clientWidth` also reads the width as it mounts, which forces a
  // layout of the whole page in the middle of rendering it (the observer still reports before the first paint).
  const followSendWidth: Attachment<HTMLElement> = (node) => {
    const observer = new ResizeObserver(() => (sendWidth = node.clientWidth));
    observer.observe(node);

    return () => observer.disconnect();
  };

  let editor = $state<EditorControls>();
  const submit = () => box?.closest("form")?.requestSubmit();

  function onkeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || keybindings.recording) return;
    const alternate = keybindings.matches(event, "composer:alternate");

    if (!alternate && !keybindings.matches(event, "composer:send")) return;
    event.preventDefault();

    if (sendBlocker || sending) return;

    if (onqueue && alternate) (primary === "queue" ? (onalternate ?? onqueue) : onqueue)();
    else submit();
  }
</script>

<div class={["grid grid-cols-1", className]}>
  <div
    class={[
      "relative rounded-2xl bg-surface shadow-sm ring-1 [--composer-send-width:--spacing(9)] sm:[--composer-send-width:--spacing(8)] dark:shadow-none",
      disabled && "*:opacity-70",
      shellMode
        ? "ring-rose-600 has-focus-visible:ring-rose-600 dark:ring-rose-400 dark:has-focus-visible:ring-rose-400"
        : dragging
          ? "ring-2 ring-brand-600 dark:ring-brand-500"
          : "ring-zinc-950/10 has-focus-visible:ring-accent dark:ring-white/10",
    ]}
    bind:this={box}
    onbeforeinput={() => onexpand?.("typing")}
    onpointerdown={() => onexpand?.("pointer")}
    data-compact={compact || undefined}
    data-shell-mode={shellMode || undefined}
    style:--composer-send-width={sendWidth === undefined ? undefined : `${sendWidth}px`}
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
          {hint}
          {disabled}
          {autofocus}
          sources={shellMode ? undefined : sources}
          {triggers}
          anchor={box}
          {onkeydown}
          {onpaste}
          {acceptChip}
          singleLine={compact}
          class={["text-base/6 sm:text-sm/6", shellMode && "font-mono", disabled && "cursor-not-allowed"]}
        />
      {/if}
    </div>
    {#if shell}
      <p class="min-h-5 px-4 text-xs/5 text-rose-700 dark:text-rose-300" role="status">
        {#if shellMode}Runs as a shell command when delivered.{/if}
      </p>
    {/if}
    <input type="hidden" {name} value={shell && value.trimStart().startsWith("!") ? value.trimEnd() : trimmed.text} />
    {#if trimmed.mentions.length > 0}<input
        type="hidden"
        name="mentions"
        value={JSON.stringify(mentionsToWire(draft ? draft.wire(trimmed.mentions) : trimmed.mentions))}
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
        {#if draft?.notice || shellBlocker || draft?.blocker}
          <HintIcon
            label="Attachment information"
            text={draft?.notice ?? shellBlocker ?? draft?.blocker ?? ""}
            warning={Boolean(draft?.notice || shellBlocker)}
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
              class="relative grid size-9 shrink-0 place-items-center rounded-full bg-action text-on-accent focus-ring not-disabled:hover:bg-action-hover not-disabled:active:bg-action-hover disabled:bg-zinc-950/10 disabled:text-zinc-400 sm:size-8 dark:disabled:bg-white/10 dark:disabled:text-zinc-500"
              aria-label={sendLabel}
              {@attach tooltip(sendLabel, { hotkey: keybindings.get("composer:send")[0] })}
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
  {#each draft?.attached.filter((file) => file.contextScope) ?? [] as file (file.key)}
    <p role="status" class="px-1 pt-2 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      PR context: {file.contextScope}
    </p>
  {/each}
  {#if meta}
    <ComposerFold open={!compact}>
      <div class="min-w-0 px-1 pt-2 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
        {@render meta()}
      </div>
    </ComposerFold>
  {/if}
</div>
{#if draft}<EditorAttachmentPreview {draft} {editor} />{/if}

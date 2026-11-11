<script lang="ts">
  import { MentionKind, type Mention, type ui } from "@canopy/contracts";
  import EditorAttachmentPreview from "#lib/features/attachments/EditorAttachmentPreview.svelte";
  import type { ClassValue } from "svelte/elements";
  import { restoreCaret } from "#lib/features/mentions/caret.ts";
  import { trimValue, type EditorControls } from "#lib/features/mentions/editor.ts";
  import MentionEditor from "#lib/features/mentions/MentionEditor.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import { shake } from "#lib/shared/ui/motion.ts";
  import { registerUnsentWork } from "#lib/features/workers/unsent-work.ts";

  /**
   * Inline edit of a queued message (it keeps its place, overrides and quotes): the composer's text field, so the
   * message's files are the same badges and its mentions the same chips (docs/ui-api.md, "Kolejka"). A badge goes
   * whole with Backspace or Delete and Undo brings it back; a file whose badge is gone leaves the message on Save,
   * which the line under the field says. Enter saves, Shift+Enter adds a line, Escape cancels. `onsave` gets the
   * text with its mentions' ranges and answers with an error to show, if any (e.g. the message started meanwhile).
   * `allowEmpty`: the message carries files or quotes, the text may go.
   */
  let {
    text,
    mentions: initial = [],
    onsave,
    oncancel,
    allowEmpty = false,
    attachments = [],
    class: className,
  }: {
    text: string;
    mentions?: readonly Mention[];
    onsave: (text: string, mentions: Mention[]) => Promise<string | undefined>;
    oncancel: () => void;
    allowEmpty?: boolean;
    attachments?: readonly ui.Attachment[];
    class?: ClassValue;
  } = $props();

  // svelte-ignore state_referenced_locally
  let value = $state(text);

  // svelte-ignore state_referenced_locally
  let mentions = $state<Mention[]>([...initial]);
  let saving = $state(false);
  let error = $state<string | undefined>(undefined);
  let editor = $state<EditorControls>();
  const id = $props.id();

  const key = (list: readonly Mention[]) => list.map((m) => `${m.kind}:${m.name}:${m.start}-${m.end}`).join("|");

  $effect(() => registerUnsentWork(() => saving || value !== text || key(mentions) !== key(initial)));

  /** Files the message had in its text whose badge is gone: they leave it on Save. */
  const leaving = $derived(
    initial.flatMap((m) =>
      m.kind === MentionKind.ATTACHMENT && !mentions.some((x) => x.kind === m.kind && x.name === m.name)
        ? [m.label || "a file"]
        : [],
    ),
  );

  // The caret at the end, as in a field that opens to edit.
  $effect(() => {
    const root = editor?.root;

    if (!root) return;
    root.focus({ preventScroll: true });
    restoreCaret(root, undefined);
  });

  async function save(event?: SubmitEvent) {
    event?.preventDefault();

    if (saving) return;

    if (value === text && key(mentions) === key(initial)) return oncancel();
    const trimmed = trimValue({ text: value, mentions });
    saving = true;
    error = await onsave(trimmed.text, trimmed.mentions);
    saving = false;
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      oncancel();
    } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void save();
    }
  }
</script>

<form class={["grid grid-cols-1 gap-2 p-1", className]} onsubmit={save}>
  <!-- The field's box is the wrapper's: the editor keeps its own outline-none (kit classes on it would lose). -->
  <div
    class="rounded-lg bg-surface px-3 py-2 outline-1 -outline-offset-1 outline-divider has-focus:outline-2 has-focus:outline-accent sm:py-1.5"
    {@attach shake(error)}
  >
    <MentionEditor
      id="{id}-text"
      label="Edit queued message"
      bind:value
      bind:mentions
      bind:editor
      {onkeydown}
      class="max-h-40 min-h-0 scroll-stable overflow-y-auto text-base/6 sm:text-sm/6"
    />
  </div>
  <div class="flex items-center justify-end gap-2">
    {#if error}
      <p id="{id}-error" class="min-w-0 flex-1 text-sm/5 text-rose-700 sm:text-xs/5 dark:text-rose-400" role="alert">
        {error}
      </p>
    {:else if leaving.length > 0}
      <p class="min-w-0 flex-1 text-sm/5 text-pretty text-zinc-500 sm:text-xs/5 dark:text-zinc-400" role="status">
        {leaving.length === 1 ? `${leaving[0]} leaves` : `${leaving.length} files leave`} the message when you save.
      </p>
    {/if}
    <Button variant="ghost" size="sm" onclick={oncancel}>Cancel</Button>
    <Button type="submit" size="sm" loading={saving} disabled={!allowEmpty && !value.trim()}>Save</Button>
  </div>
</form>
<EditorAttachmentPreview {attachments} {editor} />

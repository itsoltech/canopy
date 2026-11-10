<script lang="ts">
  import type { Mention } from "@canopy/contracts";
  import type { EditorControls } from "#lib/features/mentions/editor.ts";
  import { filesOf, type AttachmentDraft } from "#lib/features/attachments/draft.svelte.ts";
  import { pastedFiles, UNREACHABLE_FILES } from "#lib/features/attachments/clipboard.ts";
  import { chipOf, showUploads } from "#lib/features/attachments/inline-chip.ts";
  import { useFileIntake } from "#lib/features/attachments/file-intake.svelte.ts";
  import EditorAttachmentPreview from "#lib/features/attachments/EditorAttachmentPreview.svelte";

  let {
    draft,
    editor,
    root,
    disabled,
    value,
    mentions,
  }: {
    draft: AttachmentDraft;
    editor: EditorControls | undefined;
    root: HTMLElement | undefined;
    disabled: boolean;
    value: string;
    mentions: Mention[];
  } = $props();

  let picker: HTMLInputElement | undefined;
  const intake = useFileIntake();

  function add(files: File[], point?: { x: number; y: number }) {
    if (disabled) return;
    const added = draft.add(files);
    editor?.insertChips(added.map(chipOf), point);
  }

  export function pick() {
    picker?.click();
  }

  export function paste(event: ClipboardEvent) {
    if (disabled) return;
    const pasted = pastedFiles(event.clipboardData);

    if (pasted.unreachable) draft.notice = UNREACHABLE_FILES;

    if (pasted.files.length && !pasted.text) event.preventDefault();
    add(pasted.files);
  }

  $effect(() => draft.place(mentions));

  $effect(() => {
    void value;
    void mentions;
    const states = draft.files.map((f) => `${f.key}:${f.status}:${f.progress}`).join("|");

    if (editor?.root && states !== undefined) showUploads(editor.root, (key) => draft.file(key));
  });

  $effect(() => {
    if (!root || disabled) return;
    const node = root;

    const drop = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      add(filesOf(event.dataTransfer), { x: event.clientX, y: event.clientY });
    };

    const over = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };

    node.addEventListener("drop", drop);
    node.addEventListener("dragover", over);

    const stop = intake?.register({
      root: node,
      files: (files) => add(files),
      notice: (text) => {
        draft.notice = text;
      },
    });

    return () => {
      stop?.();
      node.removeEventListener("drop", drop);
      node.removeEventListener("dragover", over);
    };
  });
</script>

<input
  bind:this={picker}
  type="file"
  name="botFiles"
  aria-label="Attach files"
  multiple
  class="hidden"
  onchange={() => {
    add(Array.from(picker?.files ?? []));
    if (picker) picker.value = "";
  }}
/>
<EditorAttachmentPreview {draft} {editor} />

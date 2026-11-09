<script lang="ts">
  import { MentionKind, type ui } from "@canopy/contracts";
  import { attachmentPreviewKind } from "@canopy/domain/attachment-preview";
  import type { EditorControls } from "#lib/features/mentions/editor.ts";
  import type { AttachmentDraft } from "./draft.svelte.ts";
  import AttachmentPreview from "./AttachmentPreview.svelte";
  import AttachmentChipCard from "./AttachmentChipCard.svelte";
  import Lightbox from "./Lightbox.svelte";

  let {
    draft,
    attachments = [],
    editor,
  }: { draft?: AttachmentDraft; attachments?: readonly ui.Attachment[]; editor: EditorControls | undefined } = $props();

  let selected = $state<{ key: string; anchor: HTMLElement }>();
  let open = $state(false);
  const file = $derived(selected && draft?.file(selected.key));
  const stored = $derived(file?.attachment ?? attachments.find((attachment) => attachment.id === selected?.key));

  $effect(() => {
    const root = editor?.root;

    if (!root) return;

    const select = (event: Event, opening = false) => {
      const chip = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-attachment]") : null;
      const key = chip?.dataset["attachment"];

      if (!chip || !key || (!draft?.file(key) && !attachments.some((attachment) => attachment.id === key)) || open)
        return;
      selected = { key, anchor: chip };

      if (opening) open = true;
    };

    const hover = (event: PointerEvent) => {
      if (event.pointerType === "mouse") select(event);
    };

    const focus = (event: FocusEvent) => select(event);
    const click = (event: MouseEvent) => select(event, true);

    const keydown = (event: KeyboardEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.matches("[data-attachment]") ||
        !["Enter", " "].includes(event.key)
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      select(event, true);
    };

    root.addEventListener("pointerover", hover);
    root.addEventListener("focusin", focus);
    root.addEventListener("click", click);
    root.addEventListener("keydown", keydown, true);

    return () => {
      root.removeEventListener("pointerover", hover);
      root.removeEventListener("focusin", focus);
      root.removeEventListener("click", click);
      root.removeEventListener("keydown", keydown, true);
    };
  });
</script>

{#if selected}
  {#if stored && attachmentPreviewKind(stored) !== "file"}
    <AttachmentPreview file={stored} anchor={selected.anchor} bind:open />
  {:else if file?.image && file.localUrl && file.status !== "failed"}
    <Lightbox bind:open src={file.localUrl} name={file.name} />
  {:else if file || stored}
    {#if stored}<AttachmentPreview file={stored} anchor={selected.anchor} />{/if}
    <AttachmentChipCard
      bind:open
      {file}
      attachment={stored}
      anchor={selected.anchor}
      onremove={file
        ? () => editor?.removeChips((m) => m.kind === MentionKind.ATTACHMENT && m.name === selected?.key)
        : undefined}
    />
  {/if}
{/if}

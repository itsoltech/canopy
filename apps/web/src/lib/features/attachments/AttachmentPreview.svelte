<script lang="ts">
  import { untrack } from "svelte";
  import type { ui } from "@canopy/contracts";
  import { formatSize } from "@canopy/domain";
  import { attachmentPreviewKind } from "@canopy/domain/attachment-preview";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";
  import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
  import Lightbox from "./Lightbox.svelte";
  import AttachmentContent from "./AttachmentContent.svelte";
  import AttachmentImage from "./AttachmentImage.svelte";
  import { attachmentUrl } from "./preview.ts";

  let {
    file,
    anchor,
    open = $bindable(false),
  }: {
    file: ui.Attachment;
    anchor: HTMLElement | undefined;
    open?: boolean;
  } = $props();

  const kind = $derived(attachmentPreviewKind(file));
  let dimensions = $state<{ width: number; height: number }>();

  const detail = $derived(
    [
      formatSize(file.sizeBytes),
      file.width && file.height
        ? `${file.width}×${file.height}`
        : dimensions
          ? `${dimensions.width}×${dimensions.height}`
          : file.mimeType,
    ]
      .filter(Boolean)
      .join(" · "),
  );

  let hover = $state(false);
  let text = $state<string>();
  let wrap = $state(true);
  let panel = $state<HTMLDivElement>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const mode = $derived(devicePreferences.values.attachmentMarkdown);
  const isText = $derived(kind === "text" || kind === "markdown");

  function close() {
    clearTimeout(timer);
    timer = undefined;
    hover = false;
  }

  function leave() {
    clearTimeout(timer);
    timer = setTimeout(() => (hover = false), 180);
  }

  function enter() {
    clearTimeout(timer);

    if (!untrack(() => open)) timer = setTimeout(() => (hover = true), 300);
  }

  function imageLoaded(event: Event) {
    if (event.currentTarget instanceof HTMLImageElement)
      dimensions = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight };
  }

  $effect(() => {
    const node = anchor;

    if (!node) return;

    const pointer = (event: PointerEvent) => {
      if (event.pointerType === "mouse") enter();
    };

    const focus = () => {
      if (node.matches(":focus-visible")) enter();
    };

    const blur = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node) || !panel?.contains(event.relatedTarget)) close();
    };

    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };

    node.addEventListener("pointerenter", pointer);
    node.addEventListener("pointerleave", leave);
    node.addEventListener("focus", focus);
    node.addEventListener("blur", blur);
    node.addEventListener("pointerdown", close);
    node.addEventListener("keydown", escape);

    if (
      (node.matches(":hover") && matchMedia("(hover: hover) and (pointer: fine)").matches) ||
      node.matches(":focus-visible")
    )
      enter();

    return () => {
      close();
      node.removeEventListener("pointerenter", pointer);
      node.removeEventListener("pointerleave", leave);
      node.removeEventListener("focus", focus);
      node.removeEventListener("blur", blur);
      node.removeEventListener("pointerdown", close);
      node.removeEventListener("keydown", escape);
    };
  });

  $effect(() => {
    if (open) close();
  });

  $effect(() => {
    if (!hover) return;

    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };

    const focus = (event: FocusEvent) => {
      if (event.target instanceof Node && !anchor?.contains(event.target) && !panel?.contains(event.target)) close();
    };

    document.addEventListener("keydown", escape, true);
    document.addEventListener("focusin", focus);

    return () => {
      document.removeEventListener("keydown", escape, true);
      document.removeEventListener("focusin", focus);
    };
  });

  $effect(() => {
    void file.id;
    text = undefined;
    dimensions = undefined;
  });
</script>

<Popover bind:open={hover} {anchor} label={file.name} placement="top-start" focusOnOpen={false}>
  <div
    bind:this={panel}
    role="group"
    aria-label="Attachment preview"
    onpointerenter={() => clearTimeout(timer)}
    onpointerleave={leave}
    class="grid w-72 max-w-[calc(100vw-2rem)] gap-2 p-3"
  >
    {#if kind === "image"}
      <AttachmentImage
        onload={imageLoaded}
        src={attachmentUrl(file, file.hasThumbnail ? "thumbnail" : "image")}
        entityId={file.id}
        class="min-h-36 rounded-lg bg-zinc-950/3 dark:bg-white/5"
        imageClass="h-36 w-full object-contain"
      />
    {:else if isText}
      <div class="max-h-40 overflow-hidden rounded-lg bg-zinc-950/3 p-2 dark:bg-white/5">
        <AttachmentContent {file} compact />
      </div>
    {/if}
    <div class="min-w-0">
      <p class="font-medium break-all">{file.name}</p>
      <p class="text-xs/5 text-muted tabular-nums">{detail}</p>
    </div>
  </div>
</Popover>

{#if kind === "image"}
  <Lightbox
    bind:open
    src={attachmentUrl(file, "image")}
    entityId={file.id}
    name={file.name}
    {detail}
    download={attachmentUrl(file, "download")}
  />
{:else if isText}
  <Dialog bind:open title={file.name} description={detail} size="output" fullscreen>
    <div class="grid min-w-0 gap-3">
      <div class="flex flex-wrap items-center gap-2">
        {#if kind === "markdown"}
          <SegmentedChoice
            label="Markdown view"
            options={[
              { value: "rendered", label: "Rendered" },
              { value: "source", label: "Source" },
            ]}
            bind:value={() => mode, (value) => devicePreferences.set("attachmentMarkdown", value)}
          />
        {/if}
        <Button
          variant="ghost"
          size="sm"
          disabled={text === undefined || (kind === "markdown" && mode === "rendered")}
          aria-pressed={wrap}
          onclick={() => (wrap = !wrap)}>Wrap lines</Button
        >
        <span class="inline-flex size-8 items-center justify-center"
          >{#if text !== undefined}<CopyButton {text} label="Copy text" />{/if}</span
        >
        <a
          class="rounded-md px-2 py-1.5 text-sm/5 font-medium focus-ring hover:bg-zinc-950/5 dark:hover:bg-white/5"
          href={attachmentUrl(file, "download")}
          download={file.name}>Download</a
        >
      </div>
      <div class="max-h-[65dvh] min-w-0 scroll-stable overflow-auto overscroll-contain">
        <AttachmentContent {file} source={mode === "source"} {wrap} onload={(preview) => (text = preview.text)} />
      </div>
    </div>
  </Dialog>
{/if}

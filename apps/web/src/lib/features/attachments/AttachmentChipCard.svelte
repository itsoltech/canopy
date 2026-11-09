<script lang="ts">
  import { formatSize } from "@canopy/domain";
  import Button from "#lib/shared/ui/Button.svelte";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import type { DraftFile } from "./draft.svelte.ts";
  import type { ui } from "@canopy/contracts";
  import { attachmentUrl } from "./preview.ts";

  /**
   * Metadata for unsupported files and pending uploads in the composer: the whole name,
   * its size and type, the upload's progress or why it failed, and Remove (the badge and the file go, Undo brings
   * them back).
   */
  let {
    open = $bindable(false),
    file,
    attachment,
    anchor,
    onremove,
  }: {
    open?: boolean;
    file: DraftFile | undefined;
    attachment?: ui.Attachment | undefined;
    anchor: HTMLElement | undefined;
    onremove?: (() => void) | undefined;
  } = $props();

  const detail = $derived.by(() => {
    if (!file) return attachment ? `${formatSize(attachment.sizeBytes)} · ${attachment.mimeType}` : "";

    if (file.status === "failed") return file.error ?? "Upload failed.";

    if (file.status === "uploading") return `Uploading, ${Math.round(file.progress * 100)}%`;

    return [formatSize(file.size), file.attachment?.mimeType].filter(Boolean).join(" · ");
  });
</script>

<Popover
  bind:open
  label={file?.name ?? attachment?.name ?? "Attachment"}
  placement="top-start"
  {anchor}
  focusOnOpen={false}
>
  {#if file || attachment}
    <div class="grid max-w-72 gap-2 p-3">
      <div class="min-w-0">
        <p class="text-sm/5 font-medium break-all text-zinc-950 dark:text-white">{file?.name ?? attachment?.name}</p>
        <p
          class={[
            "text-sm/5 tabular-nums",
            file?.status === "failed" ? "text-rose-700 dark:text-rose-400" : "text-zinc-500 dark:text-zinc-400",
          ]}
        >
          {detail}
        </p>
      </div>
      <div class="flex justify-end">
        {#if attachment}<a
            class="rounded-md px-2 py-1 text-sm/5 focus-ring hover:bg-zinc-950/5 dark:hover:bg-white/5"
            href={attachmentUrl(attachment, "download")}
            download={attachment.name}>Download</a
          >{/if}
        {#if onremove}
          <Button
            variant="ghost"
            size="sm"
            onclick={() => {
              open = false;
              onremove?.();
            }}>Remove</Button
          >
        {/if}
      </div>
    </div>
  {/if}
</Popover>

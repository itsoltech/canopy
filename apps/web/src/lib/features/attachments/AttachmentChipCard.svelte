<script lang="ts">
  import { formatSize } from "@canopy/domain";
  import Button from "#lib/shared/ui/Button.svelte";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import type { DraftFile } from "./draft.svelte.ts";

  /**
   * What a tap on a file's badge in the composer shows (an image opens in the Lightbox instead): the whole name,
   * its size and type, the upload's progress or why it failed, and Remove (the badge and the file go, Undo brings
   * them back).
   */
  let {
    open = $bindable(false),
    file,
    anchor,
    onremove,
  }: {
    open?: boolean;
    file: DraftFile | undefined;
    anchor: HTMLElement | undefined;
    onremove: () => void;
  } = $props();

  const detail = $derived.by(() => {
    if (!file) return "";

    if (file.status === "failed") return file.error ?? "Upload failed.";

    if (file.status === "uploading") return `Uploading, ${Math.round(file.progress * 100)}%`;

    return [formatSize(file.size), file.attachment?.mimeType].filter(Boolean).join(" · ");
  });
</script>

<Popover bind:open label={file?.name ?? "Attachment"} placement="top-start" {anchor} focusOnOpen={false}>
  {#if file}
    <div class="grid max-w-72 gap-2 p-3">
      <div class="min-w-0">
        <p class="text-sm/5 font-medium break-all text-zinc-950 dark:text-white">{file.name}</p>
        <p
          class={[
            "text-sm/5 tabular-nums",
            file.status === "failed" ? "text-rose-700 dark:text-rose-400" : "text-zinc-500 dark:text-zinc-400",
          ]}
        >
          {detail}
        </p>
      </div>
      <div class="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onclick={() => {
            open = false;
            onremove();
          }}>Remove</Button
        >
      </div>
    </div>
  {/if}
</Popover>

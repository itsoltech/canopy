<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { formatSize } from "@canopy/domain";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import FileChip from "./FileChip.svelte";
  import ZoomableImage from "./ZoomableImage.svelte";
  import FileAvailability from "./FileAvailability.svelte";

  /**
   * The files of a message in the chat: images as thumbnails (tap for the full image), other files as chips with
   * name, size and type that download the file. SVG and other markup are files, never shown inline.
   */
  let { attachments, class: className }: { attachments: readonly ui.Attachment[]; class?: ClassValue } = $props();
  const url = (a: ui.Attachment, variant?: "thumbnail" | "download") => `/api/attachments/${encodeURIComponent(a.id)}${variant ? `?${variant}` : ""}`;
  const images = $derived(attachments.filter((a) => a.kind === "image"));
  const files = $derived(attachments.filter((a) => a.kind !== "image"));
</script>

<div class={["flex flex-col items-end gap-2", className]}>
  {#if images.length > 0}
    <ul role="list" class="flex max-w-[min(85%,42rem)] flex-wrap justify-end gap-2" aria-label="Images">
      {#each images as image (image.id)}
        <li>
          <FileAvailability entityId={image.id} name={image.name}>
          <ZoomableImage
            src={url(image, image.hasThumbnail ? "thumbnail" : undefined)}
            full={url(image)}
            name={image.name}
            detail={[image.width && image.height ? `${image.width}×${image.height}` : "", formatSize(image.sizeBytes)].filter(Boolean).join(" · ")}
            download={url(image, "download")}
            width={image.width}
            height={image.height}
            class="rounded-xl"
            imageClass={["max-h-40 rounded-xl object-cover", images.length > 1 ? "size-24 sm:size-28" : "sm:max-h-56"]}
          />
          </FileAvailability>
        </li>
      {/each}
    </ul>
  {/if}
  {#if files.length > 0}
    <ul role="list" class="flex max-w-[min(85%,42rem)] flex-wrap justify-end gap-2" aria-label="Files">
      {#each files as file (file.id)}
        <li class="min-w-0">
          <FileAvailability entityId={file.id} name={file.name}>
          <FileChip
            name={file.name}
            detail="{formatSize(file.sizeBytes)} · {file.mimeType}"
            href={url(file, "download")}
            class="max-w-64 rounded-xl py-2 pr-3 pl-2.5 ring-1 ring-zinc-950/10 ring-inset dark:ring-white/10"
          >
            {#snippet trailing()}<Icon name="arrow-down" class="shrink-0 fill-zinc-400 dark:fill-zinc-500" />{/snippet}
          </FileChip>
          </FileAvailability>
        </li>
      {/each}
    </ul>
  {/if}
</div>

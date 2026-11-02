<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import { formatSize } from "@open-agents/domain";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Lightbox from "./Lightbox.svelte";

  /**
   * The files of a message in the chat: images as thumbnails (tap for the full image), other files as chips with
   * name, size and type that download the file. SVG and other markup are files, never shown inline.
   */
  let { attachments }: { attachments: readonly ui.Attachment[] } = $props();
  const url = (a: ui.Attachment, variant?: "thumbnail" | "download") => `/api/attachments/${encodeURIComponent(a.id)}${variant ? `?${variant}` : ""}`;
  const images = $derived(attachments.filter((a) => a.kind === "image"));
  const files = $derived(attachments.filter((a) => a.kind !== "image"));
  let shown = $state<ui.Attachment>();
  let open = $state(false);
</script>

{#if images.length > 0}
  <ul role="list" class="flex max-w-[min(85%,42rem)] flex-wrap justify-end gap-2" aria-label="Images">
    {#each images as image (image.id)}
      <li>
        <button
          type="button"
          class="group relative block overflow-hidden rounded-xl focus-ring"
          aria-label="Open {image.name}"
          onclick={() => {
            shown = image;
            open = true;
          }}
        >
          <img
            src={url(image, image.hasThumbnail ? "thumbnail" : undefined)}
            alt={image.name}
            width={image.width || undefined}
            height={image.height || undefined}
            loading="lazy"
            class={[
              "max-h-40 w-auto max-w-full rounded-xl bg-zinc-100 object-cover outline-1 -outline-offset-1 outline-zinc-950/10 group-hover:opacity-90 dark:bg-white/5 dark:outline-white/10",
              images.length > 1 ? "size-24 sm:size-28" : "sm:max-h-56",
            ]}
          />
        </button>
      </li>
    {/each}
  </ul>
{/if}
{#if files.length > 0}
  <ul role="list" class="flex max-w-[min(85%,42rem)] flex-wrap justify-end gap-2" aria-label="Files">
    {#each files as file (file.id)}
      <li class="min-w-0">
        <a
          href={url(file, "download")}
          download={file.name}
          class="flex max-w-64 min-w-0 items-center gap-2.5 rounded-xl py-2 pr-3 pl-2.5 ring-1 ring-zinc-950/10 ring-inset focus-ring hover:bg-zinc-950/2.5 dark:ring-white/10 dark:hover:bg-white/5"
        >
          <Icon name="document-text" class="shrink-0 fill-zinc-400 dark:fill-zinc-500" />
          <span class="min-w-0">
            <span class="block truncate text-sm/5 font-medium text-zinc-950 sm:text-xs/5 dark:text-white">{file.name}</span>
            <span class="block truncate text-sm/5 text-zinc-500 tabular-nums sm:text-xs/5 dark:text-zinc-400">{formatSize(file.sizeBytes)} · {file.mimeType}</span>
          </span>
          <Icon name="arrow-down" class="shrink-0 fill-zinc-400 dark:fill-zinc-500" />
        </a>
      </li>
    {/each}
  </ul>
{/if}
{#if shown}
  <Lightbox
    bind:open
    src={url(shown)}
    name={shown.name}
    detail={[shown.width && shown.height ? `${shown.width}×${shown.height}` : "", formatSize(shown.sizeBytes)].filter(Boolean).join(" · ")}
    download={url(shown, "download")}
  />
{/if}

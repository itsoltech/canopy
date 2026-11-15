<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { GitHubImage } from "@canopy/domain/github-images";
  import type { WorkspaceFileTarget } from "@canopy/domain/workspace-file";
  import { FILE_PREVIEW_BYTES } from "@canopy/domain/workspace-file";
  import { localImagePath } from "@canopy/domain/markdown-images";
  import { safeHref } from "@canopy/domain/markdown";
  import { isAbsoluteFilePath, joinThreadPath } from "@canopy/domain/thread-files";
  import { useFileLinks } from "#lib/shared/ui/markdown/file-links.ts";
  import InlineLink from "#lib/shared/ui/InlineLink.svelte";
  import { readFile } from "./api.ts";

  let {
    value,
    target,
    path,
    class: className,
  }: {
    value: GitHubImage;
    target: WorkspaceFileTarget;
    path: string;
    class?: ClassValue;
  } = $props();

  const files = useFileLinks();
  let box = $state<HTMLSpanElement>();
  let visible = $state(false);
  let source = $state("");
  let failed = $state(false);

  const local = $derived.by(() => {
    const image = localImagePath(value.src);

    if (!image) return;

    if (isAbsoluteFilePath(image)) return image;
    const directory = /^(.*)[\\/][^\\/]+$/.exec(path)?.[1];

    return directory ? joinThreadPath(directory, image) : `./${image.replace(/^\.[\\/]/, "")}`;
  });

  const href = $derived(safeHref(value.src));

  $effect(() => {
    const element = box;
    void local;
    visible = false;

    if (!element || !local) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          visible = true;
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );

    observer.observe(element);

    return () => observer.disconnect();
  });

  $effect(() => {
    const imagePath = local;
    const thread = target.threadId;
    const item = target.itemId;
    source = "";
    failed = false;

    if (!visible || !imagePath) return;
    const controller = new AbortController();
    let objectUrl = "";

    void readFile(thread, imagePath, item, "", controller.signal)
      .then((file) => {
        if (controller.signal.aborted) return;
        const svg = file.mimeType === "image/svg+xml";

        const raster =
          /^image\/(png|jpeg|gif|webp|avif)$/.test(file.mimeType) &&
          file.imageWidth > 0 &&
          file.imageHeight > 0 &&
          file.imageWidth * file.imageHeight <= 16_000_000;

        const bytes = new Uint8Array(!svg && file.imagePreview.length ? file.imagePreview : file.content);

        if (
          (!svg && !raster) ||
          file.truncated ||
          file.imagePreviewError ||
          file.size > BigInt(FILE_PREVIEW_BYTES) ||
          !bytes.length ||
          bytes.length > FILE_PREVIEW_BYTES
        ) {
          failed = true;

          return;
        }

        // SVG stays in the browser's restricted image context: no script or external resource loads.
        objectUrl = URL.createObjectURL(
          new Blob([bytes], { type: !svg && file.imagePreview.length ? "image/png" : file.mimeType }),
        );
        source = objectUrl;
      })
      .catch(() => {
        if (!controller.signal.aborted) failed = true;
      });

    return () => {
      controller.abort();

      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  });

  function imageError(event: Event): void {
    const image = event.currentTarget;

    if (!(image instanceof HTMLImageElement) || image.src !== source) return;
    const failedSource = source;

    source = "";
    failed = true;
    URL.revokeObjectURL(failedSource);
  }
</script>

<span bind:this={box} class={["inline-block max-w-full align-middle", className]}>
  {#if source && !failed}
    <img
      src={source}
      alt={value.alt}
      width={value.width}
      height={value.height}
      referrerpolicy="no-referrer"
      class="inline-block h-auto max-w-full object-contain align-middle"
      onerror={imageError}
    />
  {:else if local && files && failed}
    <InlineLink
      onactivate={() => {
        if (local) files.open(local);
      }}
      title="Could not show this image. Open the file."
      class="text-sky-700 underline focus-ring dark:text-sky-400">{value.alt || value.src}</InlineLink
    >
  {:else if href && !local}
    <InlineLink
      {href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      class="text-sky-700 underline dark:text-sky-400">{value.alt || href}</InlineLink
    >
  {:else}
    {value.alt}
  {/if}
</span>

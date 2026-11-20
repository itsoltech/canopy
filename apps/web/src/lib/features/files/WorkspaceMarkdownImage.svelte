<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { GitHubImage } from "@canopy/domain/github-images";
  import type { WorkspaceFileTarget } from "@canopy/domain/workspace-file";
  import { localImagePath } from "@canopy/domain/markdown-images";
  import { safeHref } from "@canopy/domain/markdown";
  import { isAbsoluteFilePath, joinThreadPath } from "@canopy/domain/thread-files";
  import { useFileLinks } from "#lib/shared/ui/markdown/file-links.ts";
  import InlineLink from "#lib/shared/ui/InlineLink.svelte";
  import { workspaceImageUrl } from "./api.ts";

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
  let failedSource = $state("");

  const local = $derived.by(() => {
    const image = localImagePath(value.src);

    if (!image) return;

    if (isAbsoluteFilePath(image)) return image;
    const directory = /^(.*)[\\/][^\\/]+$/.exec(path)?.[1];

    return directory ? joinThreadPath(directory, image) : `./${image.replace(/^\.[\\/]/, "")}`;
  });

  const href = $derived(safeHref(value.src));
  const source = $derived(visible && local ? workspaceImageUrl(target.threadId, local, target.itemId ?? "") : "");

  $effect(() => {
    const element = box;
    void local;
    visible = false;
    failedSource = "";

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

  function imageError(event: Event): void {
    const image = event.currentTarget;

    if (image instanceof HTMLImageElement && image.getAttribute("src") === source) failedSource = source;
  }
</script>

<span bind:this={box} class={["inline-block max-w-full align-middle", className]}>
  {#if source && failedSource !== source}
    <img
      src={source}
      alt={value.alt}
      width={value.width}
      height={value.height}
      referrerpolicy="no-referrer"
      class="inline-block h-auto max-w-full object-contain align-middle"
      onerror={imageError}
    />
  {:else if local && files && source && failedSource === source}
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

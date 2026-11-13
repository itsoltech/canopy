<script lang="ts">
  import type { AgentMessage, GalleryImage } from "@canopy/contracts";
  import type { GitHubImage } from "@canopy/domain/github-images";
  import { safeHref } from "@canopy/domain/markdown";
  import { localImagePath } from "@canopy/domain/markdown-images";
  import { useFileLinks } from "#lib/shared/ui/markdown/file-links.ts";
  import InlineLink from "#lib/shared/ui/InlineLink.svelte";
  import InlineImage from "#lib/features/attachments/InlineImage.svelte";

  let {
    value,
    message,
    streaming,
    onopen,
  }: { value: GitHubImage; message: AgentMessage; streaming: boolean; onopen: (image: GalleryImage) => void } =
    $props();

  const files = useFileLinks();
  const stored = $derived(message.images.find((image) => image.sourcePath === value.src));
  const path = $derived(localImagePath(value.src));
  const href = $derived(safeHref(value.src));
</script>

{#if stored}
  <InlineImage image={stored} onopen={() => onopen(stored!)} />
{:else if path && streaming}
  <span
    class="my-2 inline-grid aspect-video w-80 max-w-full place-items-center rounded-lg bg-zinc-950/3 p-3 align-top text-sm/5 text-zinc-500 dark:bg-white/5"
    role="status">Preparing image…</span
  >
{:else if path && files}
  <span
    class="my-2 inline-grid aspect-video w-80 max-w-full place-items-center rounded-lg bg-zinc-950/3 p-3 align-top dark:bg-white/5"
  >
    <InlineLink
      onactivate={() => files.open(path!)}
      title={message.imageError || "Image not saved. Open the file."}
      class="rounded bg-zinc-950/5 px-1 text-sky-700 underline focus-ring dark:bg-white/10 dark:text-sky-400"
      >{value.alt || path}</InlineLink
    >
  </span>
{:else if href}
  <InlineLink {href} target="_blank" rel="noopener noreferrer nofollow" class="text-sky-700 underline dark:text-sky-400"
    >{value.alt || href}</InlineLink
  >
{:else}
  {value.alt}
{/if}

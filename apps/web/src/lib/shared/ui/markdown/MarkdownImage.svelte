<script lang="ts">
  import type { GitHubImage } from "@canopy/domain/github-images";
  import { safeHref } from "@canopy/domain/markdown";
  import { fileHrefOf } from "@canopy/domain/file-references";
  import InlineLink from "../InlineLink.svelte";
  import { useFileLinks } from "./file-links.ts";
  import { useImages } from "./images.ts";
  import MarkdownFileLink from "./MarkdownFileLink.svelte";

  let { value }: { value: GitHubImage } = $props();
  const files = useFileLinks();
  const images = useImages();
  const href = $derived(safeHref(value.src));
  const path = $derived(fileHrefOf(value.src));
</script>

{#if images.render}
  {@render images.render(value)}
{:else if files && path}
  <MarkdownFileLink {path} class="text-sky-700 underline focus-ring dark:text-sky-400"
    >{value.alt || value.src}</MarkdownFileLink
  >
{:else if href}
  <InlineLink
    {href}
    target="_blank"
    rel="noopener noreferrer nofollow"
    class="text-sky-700 underline underline-offset-2 dark:text-sky-400">{value.alt || href}</InlineLink
  >
{:else}
  {value.alt}
{/if}

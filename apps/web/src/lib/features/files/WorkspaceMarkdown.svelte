<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import WorkspaceMarkdownImage from "./WorkspaceMarkdownImage.svelte";

  let {
    text,
    path,
    loadImage,
    class: className,
  }: {
    text: string;
    /** Resolved Markdown file path, relative to the workspace or absolute on the worker. */
    path: string;
    loadImage: (path: string, href: string) => Promise<string>;
    class?: ClassValue;
  } = $props();
</script>

<Markdown {text} diagrams class={className}>
  {#snippet image(value)}<WorkspaceMarkdownImage {value} {path} {loadImage} />{/snippet}
</Markdown>

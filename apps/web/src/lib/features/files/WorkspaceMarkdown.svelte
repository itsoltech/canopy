<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { WorkspaceFileTarget } from "@canopy/domain/workspace-file";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import WorkspaceMarkdownImage from "./WorkspaceMarkdownImage.svelte";

  let {
    text,
    target,
    path,
    class: className,
  }: {
    text: string;
    target: WorkspaceFileTarget;
    /** Resolved Markdown file path, relative to the workspace or absolute on the worker. */
    path: string;
    class?: ClassValue;
  } = $props();
</script>

<Markdown {text} diagrams class={className}>
  {#snippet image(value)}<WorkspaceMarkdownImage {value} {target} {path} />{/snippet}
</Markdown>

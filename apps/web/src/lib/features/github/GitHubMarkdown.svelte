<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import GitHubImage from "./GitHubImage.svelte";

  let {
    text,
    pullRequestId,
    contentId,
    class: className,
  }: {
    text: string;
    pullRequestId: string;
    contentId: string;
    class?: ClassValue;
  } = $props();
</script>

<Markdown {text} class={className}>
  {#snippet image(value)}<GitHubImage {value} {pullRequestId} {contentId} />{/snippet}
</Markdown>

<script lang="ts">
  import { githubHtmlParts } from "@canopy/domain/github-images";
  import { useImages } from "./images.ts";

  let { text }: { text: string } = $props();
  const images = useImages();
  const parts = $derived(githubHtmlParts(text));
</script>

{#each parts as part, index (index)}
  {#if part.kind === "text"}{part.text}
  {:else if part.kind === "br"}<br />
  {:else if images.render}{@render images.render(part.image)}{/if}
{/each}

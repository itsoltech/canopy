<script lang="ts">
  import { videoControlGlyphs, type VideoControlGlyph } from "@canopy/ui/video-controls";

  let { name }: { name: VideoControlGlyph } = $props();
  const fill = $derived(name === "play" || name === "pause");
</script>

<svg
  viewBox="0 0 24 24"
  class="video-control-icon"
  fill={fill ? "currentColor" : "none"}
  stroke={fill ? "none" : "currentColor"}
  stroke-width="1.75"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#each videoControlGlyphs[name] as path (path)}
    <path d={path} />
  {/each}
</svg>

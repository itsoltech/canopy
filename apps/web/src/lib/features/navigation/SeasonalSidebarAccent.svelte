<script lang="ts">
  import { canopyTree } from "@canopy/ui/canopy-tree";
  import { sidebarTreePlacement } from "@canopy/ui/sidebar-art";
  import type { SeasonalAccent } from "./seasonal-accents.ts";

  let { accent }: { accent: SeasonalAccent } = $props();
  const { viewBox, preserveAspectRatio, transform } = sidebarTreePlacement;
  const crownClip = $props.id();
</script>

{#if accent === "snow"}
  <svg class="absolute inset-0 size-full" {viewBox} {preserveAspectRatio} aria-hidden="true" focusable="false">
    <defs>
      <clipPath id={crownClip}><path d={canopyTree.crown} /></clipPath>
    </defs>
    <g {transform} clip-path={"url(#" + crownClip + ")"}>
      <!-- The lower edge crosses all three lobes. The path closes outside the crown. -->
      <path
        class="snow"
        d="M18 38 C34 38 34 24 44 24
           S55 18 63 18 S73 23 80 23 S89 14 95 14
           S102 19 109 19 S116 17 121 18 S132 24 137 27 S144 37 156 38
           V-12 H18 Z"
      />
    </g>
  </svg>
{/if}

<style>
  .snow {
    fill: light-dark(var(--theme-surface), color-mix(in srgb, var(--theme-surface) 66%, var(--theme-ink)));
    stroke: currentColor;
    stroke-width: 0.85;
    stroke-opacity: 0.32;
    stroke-linejoin: round;
  }
</style>

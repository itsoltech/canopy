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
      <path
        class="snow"
        d="M23 10H59L57 17C52 17 51 23 45 23C40 23 39 27 36 31C32 37 30 34 25 38Z
           M53 -8H122V11C116 13 115 19 108 19C102 19 101 14 95 14C88 14 87 23 80 23C74 23 73 18 67 18C62 18 60 21 55 20Z
           M116 6H148L150 38C145 38 142 30 136 28C130 26 129 22 123 22C118 22 117 18 114 17Z"
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

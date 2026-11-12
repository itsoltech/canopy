<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { runningAnimation } from "../activity.ts";
  import { motion } from "@canopy/ui";
  import { threadSpinner } from "@canopy/ui/thread-row";

  /** Indeterminate progress, 16px. Decorative: pair it with visible or sr-only text. */
  let { class: className }: { class?: ClassValue } = $props();
</script>

<svg
  viewBox={threadSpinner.viewBox}
  fill="none"
  class={["size-4 shrink-0 motion-safe:animate-spin", className]}
  aria-hidden="true"
  style:animation-duration="{motion.spin}ms"
  {@attach runningAnimation}
>
  <circle
    cx={threadSpinner.center}
    cy={threadSpinner.center}
    r={threadSpinner.radius}
    class="stroke-current"
    opacity={threadSpinner.trackOpacity}
    stroke-width={threadSpinner.strokeWidth}
  />
  <path d={threadSpinner.path} class="stroke-current" stroke-width={threadSpinner.strokeWidth} stroke-linecap="round" />
</svg>

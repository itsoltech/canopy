<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { resizeToContent } from "./motion.ts";

  /**
   * A slot in a row of controls whose content changes width (a button that becomes a wider one, a pill
   * that comes and goes): it eases to the new width (card resize, motion.css `t-resize`), so the
   * neighbours glide. Focus rings and touch targets may overhang it by --spacing(1).
   */
  let { class: className, children }: { class?: ClassValue; children?: Snippet } = $props();
</script>

<span
  class={["t-resize flex shrink-0 justify-end overflow-clip [overflow-clip-margin:--spacing(1)]", className]}
  {@attach resizeToContent}>{@render children?.()}</span
>

<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { sheetDrag } from "./sheet-drag.ts";

  /** The grab bar at the top of a bottom sheet: dragging it down moves the sheet, far enough closes it (`onclose`). Pointer only (Escape and the close controls stay the keyboard way). */
  let { onclose, class: className }: { onclose: () => void; class?: ClassValue } = $props();
</script>

<div
  class={["flex h-5 cursor-grab touch-none justify-center pt-2 active:cursor-grabbing", className]}
  aria-hidden="true"
  {@attach sheetDrag(onclose)}
>
  <span class="h-1 w-9 rounded-full bg-zinc-950/15 dark:bg-white/20"></span>
</div>

<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import KeyHint from "#lib/shared/ui/KeyHint.svelte";
  import { paletteFooterClass } from "./palette-style.ts";

  /** The key legend under a palette-style list; hidden on touch screens, which have no keys to press. */
  let {
    hints,
    class: className,
  }: { hints: readonly { hotkeys: readonly string[]; label: string }[]; class?: ClassValue } = $props();
</script>

<div class={[paletteFooterClass, "flex-wrap gap-y-2", className]} aria-hidden="true">
  {#each hints as hint (hint.label)}<KeyHint
      hotkeys={hint.hotkeys}
      label={hint.label}
      class="whitespace-nowrap"
    />{/each}
</div>

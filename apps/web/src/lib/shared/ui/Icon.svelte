<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { icons, type IconName } from "./icons.ts";

  /**
   * Heroicons Micro (16px). Decorative by default; pass `label` when the icon is the only content.
   * Colour comes from `fill-*` classes (default: current text colour).
   */
  let { name, label, class: className }: { name: IconName; label?: string; class?: ClassValue } = $props();
</script>

<svg
  viewBox="0 0 16 16"
  class={["size-4 shrink-0 fill-current", className]}
  aria-hidden={label ? undefined : "true"}
  role={label ? "img" : undefined}
  aria-label={label}
>
  {#each icons[name] as path (path.d)}
    <path d={path.d} fill-rule={"evenodd" in path ? "evenodd" : undefined} clip-rule={"evenodd" in path ? "evenodd" : undefined} />
  {/each}
</svg>

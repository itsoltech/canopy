<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { icons, lineIcons, type IconName } from "./icons.ts";

  /**
   * Heroicons Micro (16px, solid) or a Lucide line icon (`lineIcons`, stroke). Decorative by default; pass
   * `label` when the icon is the only content. Colour: solid ones from `fill-*` classes, line ones from the text
   * colour (`stroke` attribute); both default to the current text colour, as attributes so any class wins.
   */
  let { name, label, size = "md", class: className }: { name: IconName; label?: string; size?: "xs" | "sm" | "md"; class?: ClassValue } = $props();
  const dimensions = $derived(size === "xs" ? "size-3" : size === "sm" ? "size-3.5" : "size-4");
</script>

{#if name in lineIcons}
  <!-- Lucide draws edge to edge; a 2-unit margin (28-unit view) sets it at the optical size of the micro set,
       the stroke widened so its weight stays at ~1.7 px. -->
  <svg
    viewBox="-2 -2 28 28"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class={["shrink-0", dimensions, className]}
    aria-hidden={label ? undefined : "true"}
    role={label ? "img" : undefined}
    aria-label={label}
  >
    {#each lineIcons[name as keyof typeof lineIcons] as d (d)}<path {d} />{/each}
  </svg>
{:else}
  <svg
    viewBox="0 0 16 16"
    fill="currentColor"
    class={["shrink-0", dimensions, className]}
    aria-hidden={label ? undefined : "true"}
    role={label ? "img" : undefined}
    aria-label={label}
  >
    {#each icons[name as keyof typeof icons] as path (path.d)}
      <path d={path.d} fill-rule={"evenodd" in path ? "evenodd" : undefined} clip-rule={"evenodd" in path ? "evenodd" : undefined} />
    {/each}
  </svg>
{/if}

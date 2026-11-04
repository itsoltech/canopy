<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { icons, type IconName } from "./icons.ts";

  /**
   * Family-independent SVG from the shared map. Decorative by default; pass `label` for standalone meaning.
   * Neutral icons are muted; semantic colours and contrasting button glyphs can use `tone="inherit"`.
   * Explicit text/fill classes still win over the default colour.
   */
  let {
    name,
    label,
    size = "md",
    tone = "muted",
    class: className,
  }: {
    name: IconName;
    label?: string;
    size?: "xs" | "sm" | "md";
    tone?: "muted" | "inherit";
    class?: ClassValue;
  } = $props();

  const dimensions = $derived(size === "xs" ? "size-3" : size === "sm" ? "size-3.5" : "size-4");
  const icon = $derived(icons[name]);
</script>

<svg
  viewBox={icon.viewBox}
  fill={icon.fill}
  stroke={icon.stroke}
  stroke-width={icon.strokeWidth}
  stroke-linecap="round"
  stroke-linejoin="round"
  class={["shrink-0", tone === "muted" && "icon-muted", dimensions, className]}
  aria-hidden={label ? undefined : "true"}
  role={label ? "img" : undefined}
  aria-label={label}
>
  {#each icon.paths as path (path.d)}
    <path
      d={path.d}
      fill={icon.fill === "none" ? "none" : undefined}
      fill-rule={path.evenodd ? "evenodd" : undefined}
      clip-rule={path.evenodd ? "evenodd" : undefined}
    />
  {/each}
</svg>

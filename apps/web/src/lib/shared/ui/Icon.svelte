<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { icons, iconStyle, type IconName } from "./icons.ts";

  /**
   * Family-independent SVG from the shared map. Decorative by default; pass `label` for standalone meaning.
   * Neutral icons are muted; semantic colours and contrasting button glyphs can use `tone="inherit"`.
   * Explicit text colour classes still win over the default colour.
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
  const paths = $derived(icons[name]);
</script>

<svg
  viewBox={iconStyle.viewBox}
  fill="none"
  stroke="currentColor"
  stroke-width={iconStyle.strokeWidth}
  stroke-linecap="round"
  stroke-linejoin="round"
  class={["shrink-0", tone === "muted" && "icon-muted", dimensions, className]}
  aria-hidden={label ? undefined : "true"}
  role={label ? "img" : undefined}
  aria-label={label}
>
  {#each paths as d (d)}
    <path {d} fill="none" />
  {/each}
</svg>

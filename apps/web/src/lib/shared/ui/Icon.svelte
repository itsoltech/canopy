<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { useDensity } from "./density.ts";
  import { icons, iconStyle, type IconName } from "./icons.ts";

  /**
   * Family-independent SVG from the shared map. Decorative by default; pass `label` for standalone meaning.
   * Neutral icons are muted; semantic colours and contrasting button glyphs can use `tone="inherit"`.
   * Explicit text colour classes still win over the default colour. Without a `size` it is 16px, and 14px from `sm`
   * in an overlay (docs/ui-scale.md).
   */
  let {
    name,
    label,
    size,
    tone = "muted",
    class: className,
  }: {
    name: IconName;
    label?: string;
    size?: "xs" | "sm" | "md";
    tone?: "muted" | "inherit";
    class?: ClassValue;
  } = $props();

  const overlay = useDensity() === "overlay";

  const dimensions = $derived(
    size === "xs"
      ? "size-3"
      : size === "sm"
        ? "size-3.5"
        : size === "md" || !overlay
          ? "size-4"
          : "size-(--icon-standard) sm:size-(--icon-compact)",
  );

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

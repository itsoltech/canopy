<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { fileGlyph } from "@canopy/ui/file-icons";
  import Icon from "./Icon.svelte";

  /** Decorative type glyph for a file path: a language mark in its colour, or a kit icon for generic kinds. */
  let { path, class: className }: { path: string; class?: ClassValue } = $props();

  const glyph = $derived(fileGlyph(path));
</script>

<span
  aria-hidden="true"
  class={[
    "flex size-4 shrink-0 items-center justify-center",
    glyph.light && "text-(--file-light) dark:text-(--file-dark)",
    className,
  ]}
  style:--file-light={glyph.light || undefined}
  style:--file-dark={glyph.dark || undefined}
>
  {#if glyph.path}
    <svg viewBox="0 0 24 24" fill="currentColor" class="size-3.5"><path d={glyph.path} /></svg>
  {:else}
    <Icon name={glyph.icon} tone={glyph.light ? "inherit" : "muted"} />
  {/if}
</span>

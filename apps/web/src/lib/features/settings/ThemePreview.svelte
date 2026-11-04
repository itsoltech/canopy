<script lang="ts">
  import { themeVariables, type ThemeName, type ThemeMode } from "@canopy/ui/themes";
  import type { ClassValue } from "svelte/elements";

  let { theme, mode, class: className }: { theme: ThemeName; mode: ThemeMode; class?: ClassValue } = $props();
  const colors = $derived(themeVariables(theme, mode));

  const style = $derived(
    (["canvas", "panel", "border", "muted", "surface", "accent"] as const)
      .map((key) => `--sample-${key}:${colors[key]}`)
      .join(";"),
  );
</script>

<div class={["sample flex h-12 min-w-0 overflow-hidden rounded-md", className]} {style} aria-hidden="true">
  <div class="sample-sidebar grid w-1/4 shrink-0 content-start gap-1 border-r p-1.5">
    <div class="sample-mark h-1.5 w-3/4 rounded-sm"></div>
    <div class="sample-line h-1 w-full rounded-sm"></div>
    <div class="sample-line h-1 w-2/3 rounded-sm"></div>
  </div>
  <div class="flex min-w-0 flex-1 flex-col justify-between gap-1 p-1.5">
    <div class="grid gap-0.5">
      <div class="sample-line ml-auto h-1.5 w-1/2 rounded-sm"></div>
      <div class="sample-copy h-1 w-4/5 rounded-sm"></div>
      <div class="sample-line h-1 w-3/5 rounded-sm"></div>
    </div>
    <div class="sample-composer flex items-center justify-between rounded-sm border px-1 py-0.5">
      <div class="sample-line h-1 w-1/3 rounded-sm"></div>
      <div class="sample-mark size-2 rounded-sm"></div>
    </div>
  </div>
</div>

<style>
  .sample {
    background: var(--sample-canvas);
  }
  .sample-sidebar {
    background: var(--sample-panel);
    border-color: var(--sample-border);
  }
  .sample-line {
    background: var(--sample-border);
  }
  .sample-copy {
    background: var(--sample-muted);
  }
  .sample-mark {
    background: var(--sample-accent);
  }
  .sample-composer {
    background: var(--sample-surface);
    border-color: var(--sample-border);
  }
</style>

<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { PULL_REQUEST_WIDTH } from "@canopy/domain/device-view";
  import ResizeHandle from "#lib/shared/ui/ResizeHandle.svelte";
  import { clampSize, type ResizeChange } from "#lib/shared/ui/resize-handle.ts";
  import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";

  let {
    container,
    controls,
    class: className,
  }: { container: HTMLElement | undefined; controls: string; class?: ClassValue } = $props();

  let available = $state<number>(PULL_REQUEST_WIDTH.max + PULL_REQUEST_WIDTH.minThread);
  const max = $derived(Math.max(0, Math.min(PULL_REQUEST_WIDTH.max, available - PULL_REQUEST_WIDTH.minThread)));
  const min = $derived(Math.min(PULL_REQUEST_WIDTH.min, max));
  const saved = $derived(devicePreferences.view.pullRequestWidth);
  const value = $derived(clampSize(saved || PULL_REQUEST_WIDTH.default, { min, max }));

  $effect(() => {
    const node = container;

    if (!node) return;

    const observer = new ResizeObserver(([entry]) => {
      if (entry) available = entry.contentRect.width;
    });

    observer.observe(node);

    return () => {
      observer.disconnect();
      node.style.removeProperty("--pr-panel-width");
      node.style.removeProperty("--pr-panel-max-width");
    };
  });

  $effect(() => {
    container?.style.setProperty("--pr-panel-width", `${value}px`);
    container?.style.setProperty("--pr-panel-max-width", `${max}px`);
  });

  function resize(size: number) {
    // ResizeHandle calls this once per animation frame. No diff/thread state changes during a drag.
    container?.style.setProperty("--pr-panel-width", `${size}px`);
  }

  function change({ size, reason }: ResizeChange) {
    const width = clampSize(reason === "reset" ? PULL_REQUEST_WIDTH.default : size, { min, max });
    resize(width);
    devicePreferences.setView({ pullRequestWidth: reason === "reset" ? 0 : width });
  }
</script>

<ResizeHandle
  label="Resize pull request panel"
  {controls}
  grows="left"
  {value}
  {min}
  {max}
  reset={Math.min(PULL_REQUEST_WIDTH.default, max)}
  onresize={resize}
  onchange={change}
  class={className}
/>

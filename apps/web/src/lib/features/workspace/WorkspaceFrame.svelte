<script lang="ts">
  import type { Snippet } from "svelte";
  import { FILES_PANEL_WIDTH } from "@canopy/domain/device-view";
  import type { ThreadWorkspace } from "./thread-workspace.svelte.ts";
  import ResizeHandle from "#lib/shared/ui/ResizeHandle.svelte";
  import { devicePreferences as device } from "#lib/features/settings/device-preferences.svelte.ts";

  /**
   * The thread area and the Files panel. On wide screens the grid eases the panel's column open and shut
   * (motion.css `t-panel-column`); the panel's width and whether it is open are one choice on this device, so
   * switching threads never moves anything.
   */
  let {
    state: workspace,
    children,
    panel,
  }: { state: ThreadWorkspace; children: Snippet; panel: Snippet<[number]> } = $props();

  let draft = $state<number>();

  const max = $derived(
    Math.min(FILES_PANEL_WIDTH.max, Math.max(FILES_PANEL_WIDTH.min, workspace.width - 30 * workspace.rem)),
  );

  const size = $derived(Math.min(draft ?? device.view.filesPanelWidth, max));
  const open = $derived(workspace.wide && device.view.filesPanelOpen);
</script>

<div
  bind:clientWidth={workspace.width}
  class="t-panel-column relative flex h-full min-h-0 min-w-0 grid-rows-1"
  class:grid={workspace.wide}
  style:grid-template-columns={workspace.wide ? `minmax(0,1fr) ${open ? size : 0}px` : undefined}
  data-collapsed={!open || undefined}
  data-window-side-panel={open ? "shown" : undefined}
>
  <span class="pointer-events-none invisible absolute w-[1rem]" bind:clientWidth={workspace.rem}></span>
  {@render children()}
  {@render panel(size)}
  {#if open}
    <div class="absolute inset-y-0 z-20" style:right={`${size}px`}>
      <ResizeHandle
        label="Resize Files"
        grows="left"
        value={size}
        min={FILES_PANEL_WIDTH.min}
        {max}
        reset={FILES_PANEL_WIDTH.default}
        onresize={(value) => (draft = value)}
        onchange={({ size: value }) => {
          device.setView({ filesPanelWidth: value });
          draft = undefined;
        }}
      />
    </div>
  {/if}
</div>

<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ThreadWorkspace } from "./thread-workspace.svelte.ts";
  import ResizeHandle from "#lib/shared/ui/ResizeHandle.svelte";

  let {
    state: workspace,
    children,
    sidebar,
  }: { state: ThreadWorkspace; children: Snippet; sidebar: Snippet } = $props();

  let draft = $state<number>();

  const size = $derived(
    Math.min(draft ?? workspace.view.panelWidth, Math.max(256, workspace.width - 38 * workspace.rem - 44)),
  );

  const open = $derived(!workspace.view.panelCollapsed);
</script>

<div
  bind:clientWidth={workspace.width}
  class="relative flex h-full min-h-0 min-w-0 grid-rows-1"
  class:grid={workspace.wide}
  style:grid-template-columns={workspace.wide ? `minmax(0,1fr) ${open ? size + 44 : 44}px` : undefined}
  data-window-side-panel={workspace.wide && open ? "shown" : undefined}
  style:--workspace-panel-content-width={`${size}px`}
>
  <span class="pointer-events-none invisible absolute w-[1rem]" bind:clientWidth={workspace.rem}></span>
  {@render children()}
  {@render sidebar()}
  {#if workspace.wide && open}
    <div class="absolute inset-y-0 z-20" style:right={`${size + 44}px`}>
      <ResizeHandle
        label="Resize workspace panel"
        grows="left"
        value={size}
        min={256}
        max={Math.min(384, Math.max(256, workspace.width - 38 * workspace.rem - 44))}
        reset={288}
        onresize={(value) => (draft = value)}
        onchange={({ size: value }) => {
          workspace.view.sizePanel(value);
          draft = undefined;
        }}
      />
    </div>
  {/if}
</div>

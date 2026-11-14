<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { SIDEBAR_WIDTH } from "@canopy/domain";
  import ResizeHandle from "#lib/shared/ui/ResizeHandle.svelte";
  import { SIDEBAR_ID, type SidebarLayout } from "./sidebar-layout.svelte.ts";

  /**
   * The desktop sidebar's column with its resize handle on the edge. The column's width is `--sidebar-extent`
   * (layout.css), which eases to 0 when collapsed (motion.css `t-sidebar`); the thread's chat column eases the
   * same value on the same timing, so both move in one frame. The panel keeps the full width on the column's
   * edge and fades, so its content never re-wraps. A collapsed column is inert. Hidden below lg (the drawer takes
   * over).
   */
  let {
    sidebar,
    children,
    class: className,
  }: { sidebar: SidebarLayout; children: Snippet; class?: ClassValue } = $props();
</script>

<aside
  id={SIDEBAR_ID}
  aria-label="Sidebar"
  class={["t-sidebar relative w-(--sidebar-extent) shrink-0 max-lg:hidden", className]}
  data-collapsed={sidebar.collapsed || undefined}
  inert={sidebar.collapsed && !sidebar.dragging}
>
  <div class="t-sidebar-panel absolute inset-y-0 right-0 w-(--sidebar-width) border-r border-divider bg-panel">
    {@render children()}
  </div>
</aside>
<!-- Outside the column: it stays on the edge (and keeps its drag) while the column snaps shut. -->
<div class={["relative z-10 w-0 shrink-0 max-lg:hidden", sidebar.collapsed && !sidebar.dragging && "invisible"]}>
  <ResizeHandle
    label="Resize sidebar"
    controls={SIDEBAR_ID}
    value={sidebar.width}
    min={SIDEBAR_WIDTH.min}
    max={sidebar.maxWidth}
    reset={SIDEBAR_WIDTH.default}
    collapsible
    bind:dragging={sidebar.dragging}
    onresize={(size, collapsed) => sidebar.resize(size, collapsed)}
    onchange={(change) => sidebar.change(change)}
  />
</div>

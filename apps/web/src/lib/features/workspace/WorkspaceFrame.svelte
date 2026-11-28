<script lang="ts">
  import { tick, untrack, type Snippet } from "svelte";
  import type { ThreadWorkspace } from "./thread-workspace.svelte.ts";
  import ResizeHandle from "#lib/shared/ui/ResizeHandle.svelte";
  import { duration } from "#lib/shared/ui/motion.ts";
  import { workspaceFileDrag, type WorkspaceFileDrag } from "./file-drag.ts";
  import { useFileIntake } from "#lib/features/attachments/file-intake.svelte.ts";

  /**
   * The thread area and shared Files/Preview panel. The grid eases the panel's column open and shut
   * (motion.css `t-panel-column`); changing threads restores each thread’s panel instantly.
   */
  let {
    state: workspace,
    children,
    panel,
  }: { state: ThreadWorkspace; children: Snippet; panel: Snippet<[number]> } = $props();

  const size = $derived(workspace.panelSize);
  const open = $derived(workspace.filesOpen);
  const intake = useFileIntake();
  let pending = $state<WorkspaceFileDrag[]>([]);
  let root = $state<HTMLDivElement>();
  let visibility = $state(0);
  let motionThread = $state("");
  let panelMoving = $state(false);
  let previousPanel: { thread: string; width: number } | undefined;

  $effect.pre(() => {
    const thread = workspace.threadId();
    const width = open ? size : 0;
    const moving = previousPanel?.thread === thread && previousPanel.width !== width;
    panelMoving = moving;
    previousPanel = { thread, width };

    if (!moving) return;
    const timer = setTimeout(() => (panelMoving = false), duration(open ? "slow" : "medium") + 50);

    return () => clearTimeout(timer);
  });

  $effect.pre(() => {
    const id = workspace.threadId();
    void tick().then(() => {
      if (!root || workspace.threadId() !== id) return;
      // Commit the restored column, panel and sheet styles before re-enabling their transitions.
      void root.offsetWidth;
      motionThread = id;
    });
  });

  $effect(() => {
    if (!root || pending.length === 0) return;
    const observer = new MutationObserver(() => visibility++);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "inert"],
      childList: true,
      subtree: true,
    });

    return () => observer.disconnect();
  });

  $effect.pre(() => {
    workspace.threadId();

    return () => (pending = []);
  });

  $effect(() => {
    if (workspace.current || pending.length === 0) return;
    void visibility;
    const target = intake?.target?.workspace;

    if (!target || target.threadId !== workspace.threadId()) return;
    const files = pending;
    pending = [];
    untrack(() => {
      for (const file of files) if (file.threadId === target.threadId) target.mention(file.path);
    });
  });

  function overFile(event: DragEvent) {
    return workspace.current && event.target instanceof Element && event.target.closest("#workspace-content");
  }
</script>

<div
  bind:this={root}
  ondragovercapture={(event) => {
    if (!overFile(event) || !workspaceFileDrag(event.dataTransfer, workspace.threadId())) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }}
  ondropcapture={(event) => {
    if (!overFile(event)) return;
    const file = workspaceFileDrag(event.dataTransfer, workspace.threadId(), true);

    if (!file) return;
    event.preventDefault();
    event.stopPropagation();
    pending = [...pending, { threadId: file.threadId, path: file.path }];
    workspace.view.select("thread");
  }}
  class="t-panel-column relative flex h-full min-h-0 min-w-0 grid-rows-1"
  class:grid={workspace.wide}
  style:grid-template-columns={workspace.wide ? `minmax(0,1fr) ${open ? size : 0}px` : undefined}
  data-collapsed={!open || undefined}
  data-panel-restoring={motionThread !== workspace.threadId() || undefined}
  data-panel-moving={panelMoving || undefined}
  data-window-side-panel={open ? "shown" : undefined}
>
  <span class="pointer-events-none invisible absolute w-[1rem]" bind:clientWidth={workspace.rem}></span>
  {@render children()}
  {@render panel(size)}
  {#if open}
    <div class="absolute inset-y-0 z-20" style:right={`${size}px`}>
      <ResizeHandle
        label="Resize side panel"
        grows="left"
        value={size}
        min={workspace.panelMin}
        max={workspace.panelMax}
        reset={workspace.panelDefault}
        onresize={(value) => (workspace.panelDraft = value)}
        onchange={({ size: value }) => {
          workspace.setPanelWidth(value);
        }}
      />
    </div>
  {/if}
</div>

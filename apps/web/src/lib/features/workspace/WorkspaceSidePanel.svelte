<script lang="ts">
  import { untrack } from "svelte";
  import type { ui } from "@canopy/contracts";
  import type { ThreadWorkspace } from "./thread-workspace.svelte.ts";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";
  import WorkspaceFiles from "./WorkspaceFiles.svelte";
  import AgentPreviewPanel from "#lib/features/preview/AgentPreviewPanel.svelte";

  let {
    state: workspace,
    root,
    width,
    threadId,
    worker,
    offline = "",
  }: {
    state: ThreadWorkspace;
    root: string;
    width: number;
    threadId: string;
    worker?: ui.Worker;
    offline?: string;
  } = $props();

  const open = $derived(workspace.filesOpen);
  const sheet = $derived(!workspace.wide && workspace.panelOpen);
  let used = $state(false);
  let filesUsed = $state(false);
  let previewUsed = $state(false);

  $effect.pre(() => {
    void threadId;
    used = false;
    filesUsed = false;
    previewUsed = false;
  });

  $effect.pre(() => {
    const choice = workspace.previewChoice;
    const workerId = worker?.id;

    if (!workerId) return;
    untrack(() => {
      if (choice.workerId && choice.workerId !== workerId) {
        choice.target = undefined;
        choice.selection = undefined;
      }

      choice.workerId = workerId;
    });
  });

  $effect(() => {
    if (open || sheet) used = true;

    if (used && workspace.panelMode === "files") filesUsed = true;

    if (used && workspace.panelMode === "preview") previewUsed = true;
  });
</script>

{#snippet content(active: boolean)}
  <div class="density-chrome flex h-full min-h-0 min-w-0 flex-col bg-surface">
    <div class="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-divider px-3">
      <SegmentedChoice
        label="Side panel"
        bind:value={workspace.panelMode}
        options={[
          { value: "files", label: "Files" },
          { value: "preview", label: "Preview" },
        ]}
      />
      <IconButton size="sm" icon="x-mark" label="Close side panel" onclick={() => (workspace.panelOpen = false)} />
    </div>
    <div class="min-h-0 flex-1">
      <div
        class="h-full min-h-0"
        class:hidden={workspace.panelMode !== "files"}
        inert={workspace.panelMode !== "files"}
      >
        {#if filesUsed}
          <WorkspaceFiles
            view={workspace.view}
            {root}
            onopen={() => {
              if (!workspace.wide) workspace.panelOpen = false;
            }}
          />
        {/if}
      </div>
      <div
        class="h-full min-h-0"
        class:hidden={workspace.panelMode !== "preview"}
        inert={workspace.panelMode !== "preview"}
      >
        {#if previewUsed}{#key `${threadId}:${worker?.id ?? ""}`}<AgentPreviewPanel
              {threadId}
              {worker}
              selection={workspace.previewChoice.selection}
              onselectionfocus={() => (workspace.previewChoice.selection = undefined)}
              bind:tool={workspace.previewTool}
              bind:target={workspace.previewChoice.target}
              {offline}
              active={active && workspace.panelMode === "preview"}
            />{/key}{/if}
      </div>
    </div>
  </div>
{/snippet}

{#if workspace.wide}
  <aside
    aria-label="Side panel"
    class="relative min-h-0 min-w-0 overflow-hidden"
    inert={!open}
    data-collapsed={!open || undefined}
  >
    <div
      class="t-panel absolute inset-y-0 left-0 flex min-h-0 flex-col border-l border-divider bg-surface"
      style:width={`${width}px`}
    >
      {#if used}{@render content(open)}{/if}
    </div>
  </aside>
{:else}
  <Dialog bind:open={() => sheet, (value) => (workspace.panelOpen = value)} title="Files and preview" bare fullscreen>
    {#if sheet}<div class="h-(--window-safe-height) min-h-0 pt-3">{@render content(true)}</div>{/if}
  </Dialog>
{/if}

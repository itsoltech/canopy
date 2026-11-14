<script lang="ts">
  import type { Workspace } from "@canopy/domain/workspace";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import { devicePreferences as device } from "#lib/features/settings/device-preferences.svelte.ts";
  import WorkspaceFiles from "./WorkspaceFiles.svelte";

  /**
   * The thread's Files panel: the only content of the right column. It mounts on first use and then stays
   * mounted while closed, at a fixed width on the column's left edge, so it fades instead of re-wrapping
   * (motion.css `t-panel`). Narrow screens show the same tree in a sheet.
   */
  let {
    view,
    root,
    width,
    wide,
    sheet = $bindable(false),
  }: { view: Workspace; root: string; width: number; wide: boolean; sheet?: boolean } = $props();

  const open = $derived(wide && device.view.filesPanelOpen);
  let used = $state(false);

  $effect(() => {
    if (open || sheet) used = true;
  });

  $effect(() => {
    if (wide) sheet = false;
  });
</script>

{#if wide}
  <aside
    aria-label="Files"
    class="relative min-h-0 min-w-0 overflow-hidden"
    inert={!open}
    data-collapsed={!open || undefined}
  >
    <div
      class="t-panel absolute inset-y-0 left-0 flex min-h-0 flex-col border-l border-divider bg-surface"
      style:width={`${width}px`}
    >
      {#if used}<WorkspaceFiles {view} {root} />{/if}
    </div>
  </aside>
{:else}
  <Dialog bind:open={sheet} title="Files" bare sheet>
    {#if sheet}<div class="h-[65dvh] min-h-0">
        <WorkspaceFiles {view} {root} onopen={() => (sheet = false)} />
      </div>{/if}
  </Dialog>
{/if}

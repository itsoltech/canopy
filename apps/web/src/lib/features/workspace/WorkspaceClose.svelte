<script lang="ts">
  import type { WorkspaceTab } from "@canopy/domain/workspace";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { workspaceVersion } from "./workspace.svelte.ts";

  let {
    tabs,
    onclose,
    oncancel,
  }: { tabs: WorkspaceTab[]; onclose: (save: boolean) => Promise<void>; oncancel: () => void } = $props();

  const revision = $derived(workspaceVersion());

  const error = $derived.by(() => {
    void revision;

    return tabs
      .map((tab) => tab.document.error)
      .filter(Boolean)
      .join(" ");
  });

  const busy = $derived.by(() => {
    void revision;

    return tabs.some((tab) => tab.document.busy);
  });
</script>

<Dialog
  bind:open={
    () => tabs.length > 0,
    (open) => {
      if (!open) oncancel();
    }
  }
  title="Save file changes?"
  dismissible={!busy}
>
  <p>Save or discard these edits before closing the tabs.</p>
  <ul class="my-3 max-h-48 overflow-auto text-sm">
    {#each tabs.filter((tab) => tab.document.dirty) as tab}<li class="break-all">{tab.document.path}</li>{/each}
  </ul>
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  <div class="mt-6 flex flex-wrap justify-end gap-2">
    <Button disabled={busy} onclick={oncancel}>Keep editing</Button>
    <Button disabled={busy} variant="danger" onclick={() => void onclose(false)}>Discard changes</Button>
    <Button disabled={busy} variant="primary" onclick={() => void onclose(true)}>Save changes</Button>
  </div>
</Dialog>

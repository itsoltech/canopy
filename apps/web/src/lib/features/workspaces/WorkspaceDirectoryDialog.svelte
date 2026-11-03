<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import ActionForm from "#lib/shared/ui/ActionForm.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import DirectoryPicker from "./DirectoryPicker.svelte";

  /**
   * Puts a project on a worker (`?/createWorkspace`) or moves it to another directory there
   * (`?/updateWorkspace`, with `workspace`): browse accessible directories and use the open one.
   */
  let {
    open = $bindable(false),
    projectName,
    worker,
    workspace,
    error,
  }: {
    open?: boolean;
    projectName: string;
    worker: ui.Worker;
    /** Set: change this workspace's directory. */
    workspace?: ui.Workspace | undefined;
    error?: string | undefined;
  } = $props();

  let rootPath = $state("");
  const unchanged = $derived(Boolean(workspace) && rootPath === workspace?.rootPath);
</script>

<Dialog
  bind:open
  title={workspace ? `Move ${projectName} on ${worker.name}` : `Add ${projectName} to ${worker.name}`}
  description={workspace
    ? `Threads already there keep their directory (${workspace.rootPath}). New threads start in the one you choose.`
    : `Choose the project's directory on ${worker.name}. New threads on this worker start there.`}
>
  <ActionForm action={workspace ? "?/updateWorkspace" : "?/createWorkspace"} onsuccess={() => (open = false)} class="grid gap-4">
    {#snippet children({ busy, submitted })}
      {#if workspace}
        <input type="hidden" name="workspaceId" value={workspace.id} />
      {:else}
        <input type="hidden" name="workerId" value={worker.id} />
        <input type="hidden" name="label" value={worker.name} />
      {/if}
      <input type="hidden" name="rootPath" value={rootPath} />
      <DirectoryPicker workerId={worker.id} os={worker.os} initialPath={workspace?.rootPath} bind:value={rootPath} />
      {#if submitted && error}<Alert tone="error">{error}</Alert>{/if}
      <DialogActions>
        <Button onclick={() => (open = false)}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!rootPath || unchanged}>{workspace ? "Use this directory" : `Add to ${worker.name}`}</Button>
      </DialogActions>
    {/snippet}
  </ActionForm>
</Dialog>

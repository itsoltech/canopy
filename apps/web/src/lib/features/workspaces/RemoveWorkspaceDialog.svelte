<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import ActionForm from "#lib/shared/ui/ActionForm.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";

  /** Takes a project off a worker (`?/removeWorkspace`); threads already there keep working. */
  let {
    open = $bindable(false),
    projectName,
    workerName,
    workspace,
    error,
  }: {
    open?: boolean;
    projectName: string;
    workerName: string;
    workspace: ui.Workspace;
    error?: string | undefined;
  } = $props();
</script>

<Dialog
  bind:open
  title="Remove {projectName} from {workerName}?"
  description="Existing threads keep working in {workspace.rootPath}. To start new threads there, add the workspace again."
>
  <ActionForm action="?/removeWorkspace" onsuccess={() => (open = false)} class="grid gap-4">
    {#snippet children({ busy, submitted })}
      <input type="hidden" name="workspaceId" value={workspace.id} />
      {#if submitted && error}<Alert tone="error">{error}</Alert>{/if}
      <DialogActions>
        <Button onclick={() => (open = false)}>Cancel</Button>
        <Button type="submit" variant="danger" loading={busy}>Remove from {workerName}</Button>
      </DialogActions>
    {/snippet}
  </ActionForm>
</Dialog>

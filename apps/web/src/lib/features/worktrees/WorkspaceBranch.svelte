<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import BranchSwitcher from "./BranchSwitcher.svelte";
  import { switchWorkspaceBranch, workspaceBranches } from "./api.ts";
  import type { WorkspaceDraft } from "./workspace-draft.svelte.ts";

  let {
    place,
    workspace,
    worker,
    onbusy,
  }: {
    place: WorkspaceDraft;
    workspace: ui.Workspace;
    worker: ui.Worker | undefined;
    onbusy: (busy: boolean) => void;
  } = $props();

  const overview = useOverview();
  const capabilities = useGatewayCapabilities();
  const worktree = $derived(place.choice.kind === "existing" ? place.choice.worktree : undefined);
  const worktreeId = $derived(worktree?.id ?? "");

  const reason = $derived(
    !worker?.online
      ? "Reconnect this computer to switch branches."
      : !worker.workspaceBranchSwitch
        ? "Update this computer to switch branches."
        : worker.nodeId && !overview.computer(worker.nodeId)?.capabilities.includes("remote_workspace_branch_switch_v1")
          ? "Update the home computer to switch branches."
          : capabilities?.methods && !capabilities.methods.includes("SwitchWorkspaceBranch")
            ? "Update Canopy to switch branches."
            : worktree?.unavailableReason || "",
  );
</script>

{#key `${workspace.id}/${worktreeId}`}
  <BranchSwitcher
    pill
    label={place.branch || "Unknown branch"}
    currentBranch={worktree?.branch ?? place.gitRefs?.currentBranch ?? ""}
    detached={Boolean(worktree?.detachedCommit)}
    {reason}
    {onbusy}
    load={() => workspaceBranches(workspace.id, worktreeId)}
    onswitch={async (ref, stashChanges) => {
      const result = await switchWorkspaceBranch({
        workspaceId: workspace.id,
        worktreeId,
        branch: ref.name,
        remote: ref.remote,
        stashChanges,
      });
      if (result.refs) place.acceptBranch(result.refs, worktreeId);
      await place.refresh();
      return result.detail;
    }}
    class="w-full max-w-full"
  />
{/key}

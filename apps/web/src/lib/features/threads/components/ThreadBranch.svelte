<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { branchSwitchReason, distinctUpstream, headLabel } from "@canopy/domain/git-heads";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import BranchSwitcher from "#lib/features/worktrees/BranchSwitcher.svelte";
  import { threadBranches, switchThreadBranch } from "../branches.ts";

  let { thread, worker, class: className }: { thread: ui.Thread; worker?: ui.Worker; class?: ClassValue } = $props();
  const overview = useOverview();
  const capabilities = useGatewayCapabilities();
  const head = $derived(thread.worktree ?? thread.checkoutHead);
  const label = $derived(head ? headLabel(head) : "Unknown branch");
  const upstream = $derived(thread.worktree ? distinctUpstream(thread.worktree.branch, thread.worktree.baseRef) : "");

  const reason = $derived(
    branchSwitchReason(thread, worker, overview.computer(thread.nodeId)) ||
      (capabilities?.methods && !capabilities.methods.includes("SwitchThreadBranch")
        ? "Update Canopy to switch branches."
        : ""),
  );
</script>

{#key thread.id}
  <BranchSwitcher
    {label}
    currentBranch={head?.branch ?? ""}
    detached={Boolean(head?.detachedCommit)}
    {reason}
    hint={[label, upstream && `From ${upstream}`].filter(Boolean).join(" · ")}
    load={() => threadBranches(thread.id)}
    onswitch={async (ref, stashChanges) => (await switchThreadBranch(thread.id, ref, stashChanges)).detail}
    class={className}
  />
{/key}

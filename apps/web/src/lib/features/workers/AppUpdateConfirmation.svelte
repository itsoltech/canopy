<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { appRestartDescription, appRunningTurns } from "@canopy/domain/release/update-actions";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import { hasUnsentWork } from "./unsent-work.ts";
  import type { UpdatesState } from "./updates.svelte.ts";

  let {
    open = $bindable(false),
    computer,
    updates,
  }: {
    open?: boolean;
    computer: ui.ComputerUpdate;
    updates: UpdatesState;
  } = $props();

  const overview = useOverview();

  const turns = $derived(
    appRunningTurns([...(overview?.threads.values() ?? [])], computer.updates?.app?.workerId || ""),
  );

  let blocked = $state(false);

  $effect(() => {
    if (open) blocked = !computer.nodeId && hasUnsentWork();
  });
</script>

<Dialog bind:open title={`Update “${computer.name}”?`}>
  <p class="text-base/6 text-pretty whitespace-pre-line text-muted sm:text-sm/6">
    {appRestartDescription(computer.name, turns, "web")}
  </p>
  {#if blocked}<p class="mt-3 text-base/6 text-pretty text-muted sm:text-sm/6" role="status">
      Send or discard your drafts and files before updating this computer.
    </p>{/if}
  <DialogActions class="mt-5">
    <Button data-autofocus onclick={() => (open = false)}>Cancel</Button>
    <Button
      variant="danger"
      disabled={blocked || !!updates.pending || updates.snapshot?.run?.state === "running"}
      onclick={() => {
        blocked = !computer.nodeId && hasUnsentWork();
        if (blocked) return;
        open = false;
        void updates.manage(
          computer.nodeId ? { action: "computer", nodeId: computer.nodeId } : { action: "app", confirmRestart: true },
        );
      }}>Update computer</Button
    >
  </DialogActions>
</Dialog>

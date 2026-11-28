<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import WorkerRestartConfirmation from "./WorkerRestartConfirmation.svelte";
  import UpdateItem from "./UpdateItem.svelte";
  import { workerCurrent } from "./compact-updates.ts";
  import { appRowTarget, appUpdateTarget } from "@canopy/domain/release/update-plan";
  import { workerUpdateOffline, type UpdatesState } from "./updates.svelte.ts";
  import {
    binaryUpdateDetail,
    binaryUpdateStatus,
    gatewayUpdateLifecycle,
    updateInProgress,
    updateTargetKey,
    workerUpdateTarget,
  } from "@canopy/domain/release/update-status";

  let {
    worker,
    updates,
    home,
    nodeId = "",
    compact = false,
    class: className,
  }: {
    worker: ui.WorkerUpdate;
    updates: UpdatesState;
    /** The snapshot of the computer the worker belongs to (a linked computer's); this computer's by default. */
    home?: ui.UpdatesSnapshot | undefined;
    /** The linked computer the worker belongs to; empty for this computer. */
    nodeId?: string;
    compact?: boolean;
    class?: ClassValue;
  } = $props();

  let confirming = $state(false);

  const snapshot = $derived(home ?? updates.snapshot);
  const linked = $derived(!!home && home !== updates.snapshot);
  const desktop = $derived(worker.desktop);

  const homeOnline = $derived(
    !nodeId ||
      updates.snapshot?.computers.some((computer) => computer.nodeId === nodeId && computer.presence === "connected"),
  );

  const connected = $derived(homeOnline && (desktop ? desktop.connected : worker.connected));
  const current = $derived(workerCurrent(worker, snapshot?.gatewayVersion ?? ""));
  const blocked = $derived(updates.gatewayTransition || gatewayUpdateLifecycle(snapshot?.gatewayState));

  const phase = $derived(
    desktop?.phase === "downloading" ? "updating" : binaryUpdateStatus(desktop?.phase ?? worker.state),
  );

  const offline = $derived(!homeOnline || (!desktop && workerUpdateOffline(worker)));
  const target = $derived(desktop ? appRowTarget(desktop) : workerUpdateTarget(worker, snapshot?.gatewayVersion ?? ""));

  const failed = $derived(worker.state === "failed" || desktop?.phase === "failed");
  const external = $derived(worker.installKind !== "binary" && !desktop);

  const reason = $derived(
    desktop
      ? desktop.disabledReason ||
          desktop.reason ||
          (current ? "Updates with the Canopy app. You can update it here when a new version is available." : "")
      : worker.reason.replace(/^Managed externally\.\s*/, "") || (!connected ? "Update channel offline" : ""),
  );

  // A linked computer's remote desktop apps update from that computer only.
  const actionable = $derived(
    desktop
      ? !linked && desktop.connected && !desktop.disabledReason && !!appUpdateTarget(desktop)
      : worker.connected && worker.installKind === "binary" && !!snapshot?.admin && !!target,
  );

  const key = $derived(
    desktop
      ? updateTargetKey({ kind: "desktop", workerId: worker.workerId })
      : updateTargetKey({ kind: "worker", nodeId, workerId: worker.workerId }),
  );

  // A feed check keeps the settled word; the header shows the check.
  const own = $derived(
    offline
      ? "Offline"
      : desktop
        ? (phase ?? (current ? "current" : actionable ? "available" : "Unavailable"))
        : (phase ??
          (current
            ? "current"
            : external || worker.state === "managed_externally"
              ? "Managed externally"
              : worker.state === "ahead"
                ? "Newer than gateway"
                : actionable
                  ? "available"
                  : "Unavailable")),
  );

  const status = $derived(offline ? own : updates.rowStatus(key, own));
  const step = $derived(updates.failedStep(key));
  const inProgress = $derived(updateInProgress(status));
</script>

<UpdateItem
  name={worker.name}
  {compact}
  icon={desktop ? "computer-desktop" : "server"}
  current={desktop?.version || worker.version}
  target={offline ? "" : target}
  {status}
  line={desktop
    ? status === "waiting"
      ? "Restarts after its current turns end."
      : ""
    : status === phase
      ? binaryUpdateDetail(worker.state)
      : ""}
  error={status === "failed"
    ? desktop?.reason || reason || updates.snapshot?.run?.steps[step]?.reason || "The update did not finish."
    : ""}
  busy={inProgress}
  progress={desktop ? (desktop.phase === "downloading" ? desktop.progress : undefined) : worker.downloadProgress}
  class={[!connected && !inProgress && "opacity-50", className]}
>
  {#snippet action()}
    {#if !blocked && status === "failed" && step < 0 && (!linked || !desktop) && (failed || actionable)}
      <IconButton
        icon="repeat"
        size="sm"
        label="Retry"
        disabled={updates.active ||
          !connected ||
          !!desktop?.disabledReason ||
          (!desktop && (!snapshot?.admin || external))}
        loading={updates.pending === worker.workerId || updates.pending === "retry_step"}
        onclick={() => void updates.manage({ action: desktop ? "desktop" : "worker", workerId: worker.workerId }, key)}
      />
    {:else if !blocked && actionable && status === "available"}
      <IconButton
        icon="arrow-down-tray"
        size="sm"
        label={desktop ? "Update Canopy app" : `Update ${worker.name}`}
        disabled={updates.active || !connected || !!desktop?.disabledReason}
        loading={updates.pending === worker.workerId}
        onclick={() => void updates.manage({ action: desktop ? "desktop" : "worker", workerId: worker.workerId }, key)}
      />
    {:else if !blocked && !linked && desktop?.phase === "waiting_idle" && desktop.connected && !desktop.disabledReason}
      <IconButton
        icon="power"
        size="sm"
        label={`Restart ${worker.name} now…`}
        disabled={updates.active}
        onclick={() => (confirming = true)}
      />
    {:else if reason && !desktop?.disabledReason && !inProgress}<IconButton
        icon="information-circle"
        size="sm"
        label={reason}
        tooltipOptions={{ touch: "tap" }}
      />{/if}
  {/snippet}
  {#snippet errorActions()}
    {#if desktop?.phase === "failed" && !linked}
      <Button
        size="sm"
        class="justify-self-start"
        disabled={!updates.writable || !!updates.pending || blocked}
        onclick={() =>
          void updates.manage({
            action: "desktop_dismiss",
            workerId: worker.workerId,
            desktopRequestId: desktop?.requestId,
          })}>Dismiss</Button
      >
    {/if}
  {/snippet}
</UpdateItem>
{#if !compact && desktop?.disabledReason && !inProgress && (status !== "failed" || !!desktop.reason)}
  <p class="mb-2 ml-6 text-xs/5 text-pretty break-words text-muted" role="status">{desktop.disabledReason}</p>
{/if}
<WorkerRestartConfirmation bind:open={confirming} {worker} {updates} />

<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import UpdateItem from "./UpdateItem.svelte";
  import { workerCurrent } from "./compact-updates.ts";
  import type { UpdatesState } from "./updates.svelte.ts";
  import { updateInProgress, updateTargetKey, type UpdateStatus } from "@canopy/domain/release/update-status";

  let {
    worker,
    updates,
    home,
    nodeId = "",
    allowForce = false,
    class: className,
  }: {
    worker: ui.WorkerUpdate;
    updates: UpdatesState;
    /** The snapshot of the computer the worker belongs to (a linked computer's); this computer's by default. */
    home?: ui.UpdatesSnapshot | undefined;
    /** The linked computer the worker belongs to; empty for this computer. */
    nodeId?: string;
    allowForce?: boolean;
    class?: ClassValue;
  } = $props();

  let confirming = $state(false);

  const snapshot = $derived(home ?? updates.snapshot);
  const linked = $derived(!!home && home !== updates.snapshot);
  const desktop = $derived(worker.desktop);
  const current = $derived(workerCurrent(worker, snapshot?.gatewayVersion ?? ""));

  const failed = $derived(worker.state === "failed" || desktop?.phase === "failed");
  const external = $derived(worker.installKind !== "binary" && !desktop);

  const reason = $derived(
    desktop?.disabledReason ||
      desktop?.reason ||
      worker.reason.replace(/^Managed externally\.\s*/, "") ||
      (!worker.connected ? "Update channel offline" : ""),
  );

  // A linked computer's remote desktop apps update from that computer only.
  const actionable = $derived(
    desktop
      ? !linked &&
          desktop.connected &&
          !desktop.disabledReason &&
          !!desktop.availableVersion &&
          desktop.availableVersion !== desktop.version
      : worker.connected &&
          worker.installKind === "binary" &&
          !!snapshot?.admin &&
          !!worker.version &&
          worker.version !== snapshot.gatewayVersion &&
          worker.state !== "ahead",
  );

  const key = $derived(
    desktop
      ? updateTargetKey({ kind: "desktop", workerId: worker.workerId })
      : updateTargetKey({ kind: "worker", nodeId, workerId: worker.workerId }),
  );

  const PHASE = new Map<string, UpdateStatus>([
    ["queued", "queued"],
    ["downloading", "updating"],
    ["waiting_idle", "waiting"],
    ["restarting", "restarting"],
    ["failed", "failed"],
  ]);

  // A feed check keeps the settled word; the header shows the check.
  const own = $derived(
    !worker.connected
      ? "Offline"
      : external && !current
        ? "Managed externally"
        : current
          ? "current"
          : (PHASE.get(desktop ? desktop.phase : worker.state) ??
            (worker.state === "managed_externally"
              ? "Managed externally"
              : worker.state === "ahead"
                ? "Newer than gateway"
                : actionable
                  ? "available"
                  : "Unavailable")),
  );

  const status = $derived(updates.rowStatus(key, own));
  const step = $derived(updates.failedStep(key));
  const inProgress = $derived(updateInProgress(status));

  function retry() {
    const run = updates.snapshot?.run;

    if (step >= 0 && run)
      void updates.manage({ action: "retry_step", desktopRequestId: run.id, updateStepIndex: step }, key);
    else void updates.manage({ action: desktop ? "desktop" : "worker", workerId: worker.workerId }, key);
  }
</script>

<UpdateItem
  name={worker.name}
  icon={desktop ? "computer-desktop" : "server"}
  current={desktop?.version || worker.version}
  target={desktop?.targetVersion ||
    desktop?.availableVersion ||
    (worker.state !== "ahead" ? snapshot?.gatewayVersion : "")}
  {status}
  line={status === "waiting" ? "Restarts after its current turns end." : ""}
  error={status === "failed"
    ? reason || updates.snapshot?.run?.steps[step]?.reason || "The update did not finish."
    : ""}
  busy={inProgress}
  progress={desktop?.phase === "downloading" ? desktop.progress : undefined}
  class={[!worker.connected && "opacity-50", className]}
>
  {#snippet action()}
    {#if status === "failed" && (step >= 0 || (!linked && (failed || actionable)))}
      <IconButton
        icon="repeat"
        size="sm"
        label="Retry"
        disabled={updates.active || !worker.connected}
        loading={updates.pending === worker.workerId || updates.pending === "retry_step"}
        onclick={retry}
      />
    {:else if actionable && !inProgress && !current}
      <IconButton
        icon="arrow-down-tray"
        size="sm"
        label={`Update ${worker.name}`}
        disabled={updates.active || !worker.connected || (desktop && (!desktop.connected || !!desktop.disabledReason))}
        loading={updates.pending === worker.workerId}
        onclick={() => void updates.manage({ action: desktop ? "desktop" : "worker", workerId: worker.workerId }, key)}
      />
    {:else if allowForce && !linked && desktop?.phase === "waiting_idle" && desktop.connected && !desktop.disabledReason}
      <IconButton
        icon="power"
        size="sm"
        label={`Restart ${worker.name} now…`}
        disabled={updates.active}
        onclick={() => (confirming = true)}
      />
    {:else if reason && !inProgress}<IconButton
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
        disabled={!!updates.pending}
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
<Dialog bind:open={confirming} title="Restart Canopy app now?">
  <div class="grid gap-4">
    <p class="text-sm/6 text-muted">
      Restarting stops the running turns on this computer. The app reconnects by itself.
    </p>
    <div class="flex flex-wrap justify-end gap-2">
      <Button size="sm" onclick={() => (confirming = false)}>Keep waiting</Button>
      <Button
        size="sm"
        variant="primary"
        disabled={!!updates.pending ||
          snapshot?.run?.state === "running" ||
          !desktop?.connected ||
          !!desktop?.disabledReason ||
          desktop?.phase !== "waiting_idle"}
        onclick={() => {
          confirming = false;
          void updates.manage({
            action: "desktop",
            workerId: worker.workerId,
            force: true,
            desktopRequestId: desktop?.requestId ?? "",
          });
        }}>Restart now</Button
      >
    </div>
  </div>
</Dialog>

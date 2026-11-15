<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import UpdateItem from "#lib/features/workers/UpdateItem.svelte";
  import WorkerRestartConfirmation from "#lib/features/workers/WorkerRestartConfirmation.svelte";
  import type { UpdatesState } from "#lib/features/workers/updates.svelte.ts";
  import type { DesktopUpdatesState } from "./desktop-updates.svelte.ts";
  import { appRowTarget } from "@canopy/domain/release/update-plan";
  import { currentRemoteUpdate } from "@canopy/domain/release/remote-update-state";
  import { furthestStatus, updateInProgress, updateTargetKey } from "@canopy/domain/release/update-status";

  let {
    updates,
    center,
    bundled = false,
    worker,
    allowForce = false,
    class: className,
  }: {
    updates: DesktopUpdatesState;
    /** The update center: while Update all runs, this computer restarts last, by the run, never from its row. */
    center: UpdatesState;
    /** The gateway reports itself as this app's bundled one (local mode): the app includes it and its worker. */
    bundled?: boolean;
    /** This app's worker on a remote gateway, matched by the enrolled worker ID. */
    worker?: ui.WorkerUpdate | undefined;
    allowForce?: boolean;
    class?: ClassValue;
  } = $props();

  const status = $derived(updates.status);
  const ready = $derived(!!status?.stagedVersion || status?.phase === "downloaded");

  const desktop = $derived(
    worker?.desktop && currentRemoteUpdate({ ...worker.desktop, version: status?.version || worker.desktop.version }),
  );

  const target = $derived(status?.stagedVersion || status?.updateVersion || (desktop ? appRowTarget(desktop) : ""));
  const key = $derived(updateTargetKey(worker ? { kind: "desktop", workerId: worker.workerId } : { kind: "app" }));
  const step = $derived(center.failedStep(key));
  let confirming = $state(false);

  // A feed check keeps the settled word; the header shows the check.
  const own = $derived(
    !status
      ? "current"
      : ready
        ? "downloaded"
        : status.retryAt
          ? "Checks paused"
          : status.phase === "downloading"
            ? "updating"
            : status.phase === "error"
              ? "failed"
              : status.phase === "disabled"
                ? "Disabled"
                : status.publishing
                  ? "Publishing"
                  : target
                    ? "available"
                    : "current",
  );

  const requested = $derived(
    desktop?.phase === "downloading"
      ? "updating"
      : desktop?.phase === "waiting_idle"
        ? "waiting"
        : desktop?.phase === "restarting"
          ? "restarting"
          : desktop?.phase === "failed"
            ? "failed"
            : desktop?.phase === "queued"
              ? "queued"
              : desktop?.phase === "checking"
                ? "starting"
                : undefined,
  );

  const row = $derived(center.rowStatus(key, furthestStatus(own, requested)));
  const actionable = $derived(!!worker && desktop?.connected && !desktop.disabledReason);

  const error = $derived(
    desktop?.reason ||
      center.snapshot?.run?.steps[step]?.reason ||
      updates.error ||
      status?.error ||
      (status?.phase === "error" ? status.message : "") ||
      "The app update failed. Check again to retry.",
  );

  const info = $derived(
    [
      status?.publishing || (status?.retryAt ? status.message : ""),
      desktop?.disabledReason,
      bundled ? "Includes this computer’s gateway and worker." : "",
    ]
      .filter(Boolean)
      .join(" "),
  );

  function retry() {
    const run = center.snapshot?.run;

    if (step >= 0 && run)
      void center.manage({ action: "retry_step", desktopRequestId: run.id, updateStepIndex: step }, key);
    else if (worker && desktop?.phase === "failed" && actionable)
      void center.manage({ action: "desktop", workerId: worker.workerId }, key);
    else void updates.check();
  }
</script>

{#if status}
  <UpdateItem
    name={worker?.name || (bundled ? "This Canopy app" : "This computer")}
    icon="computer-desktop"
    current={status.version}
    {target}
    status={row}
    line={row === "waiting"
      ? "Restarts after its current turns end."
      : row === "queued" && ready && !worker
        ? "Restarts last, after the others."
        : ""}
    error={row === "failed" ? error : ""}
    busy={updateInProgress(row)}
    progress={status.phase === "downloading"
      ? status.progress
      : desktop?.phase === "downloading"
        ? desktop.progress
        : undefined}
    class={className}
  >
    {#snippet action()}
      {#if row === "downloaded" || (ready && row === "failed")}
        <IconButton
          icon="power"
          size="sm"
          label="Restart to update"
          tooltipText={status.phase === "checking" || status.phase === "downloading"
            ? "Restart to update after this download. Agents running on this computer stop."
            : "Restart to update. Agents running on this computer stop."}
          disabled={!!status.changingChannel || center.active}
          loading={updates.restarting}
          onclick={() => void updates.run()}
        />
      {:else if row === "failed"}
        <IconButton
          icon="repeat"
          size="sm"
          label="Retry"
          disabled={center.active}
          loading={updates.pending || center.pending === worker?.workerId || center.pending === "retry_step"}
          onclick={retry}
        />
      {:else if row === "available" && actionable && worker}
        <IconButton
          icon="arrow-down-tray"
          size="sm"
          label="Update Canopy app"
          disabled={center.active || !!status.changingChannel}
          loading={center.pending === worker.workerId}
          onclick={() => void center.manage({ action: "desktop", workerId: worker.workerId }, key)}
        />
      {:else if row === "waiting" && allowForce && actionable && worker}
        <IconButton
          icon="power"
          size="sm"
          label={`Restart ${worker.name} now…`}
          disabled={center.active}
          onclick={() => (confirming = true)}
        />
      {:else if info && !updateInProgress(row)}<IconButton
          icon="information-circle"
          size="sm"
          label={info}
          tooltipOptions={{ touch: "tap" }}
        />{/if}
    {/snippet}
    {#snippet errorActions()}
      {#if desktop?.phase === "failed" && worker}
        <Button
          size="sm"
          class="justify-self-start"
          disabled={!!center.pending}
          onclick={() =>
            void center.manage({
              action: "desktop_dismiss",
              workerId: worker.workerId,
              desktopRequestId: desktop?.requestId,
            })}>Dismiss</Button
        >
      {/if}
    {/snippet}
  </UpdateItem>
{:else if updates.error}<p
    class={["break-anywhere text-sm/5 text-rose-600 dark:text-rose-400", className]}
    role="status"
  >
    {updates.error}
  </p>{/if}
{#if worker}<WorkerRestartConfirmation bind:open={confirming} {worker} updates={center} />{/if}

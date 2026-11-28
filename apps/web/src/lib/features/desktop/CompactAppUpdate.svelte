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
    compact = false,
    restartInFooter = false,
    class: className,
  }: {
    updates: DesktopUpdatesState;
    center: UpdatesState;
    /** The gateway reports itself as this app's bundled one (local mode): the app includes it and its worker. */
    bundled?: boolean;
    /** This app's worker on a remote gateway, matched by the enrolled worker ID. */
    worker?: ui.WorkerUpdate | undefined;
    compact?: boolean;
    restartInFooter?: boolean;
    class?: ClassValue;
  } = $props();

  const status = $derived(updates.status);
  const ready = $derived(!!status?.stagedVersion || status?.phase === "downloaded");
  const windows = typeof window !== "undefined" && window.canopyDesktop?.platform === "win32";
  const manualInstall = $derived(status?.phase === "downloaded" && status.manualInstall);

  const reported = $derived(worker?.desktop ?? (bundled ? center.snapshot?.app : undefined));

  const desktop = $derived(
    reported && currentRemoteUpdate({ ...reported, version: status?.version || reported.version }),
  );

  const downloading = $derived(status?.phase === "downloading");

  const target = $derived(
    (downloading && status?.updateVersion) ||
      status?.stagedVersion ||
      status?.updateVersion ||
      (desktop ? appRowTarget(desktop) : ""),
  );

  const key = $derived(updateTargetKey(worker ? { kind: "desktop", workerId: worker.workerId } : { kind: "app" }));
  const step = $derived(center.failedStep(key));
  let confirming = $state(false);

  // A feed check keeps the settled word; the header shows the check.
  const own = $derived(
    !status
      ? "current"
      : downloading
        ? "updating"
        : ready
          ? "downloaded"
          : status.retryAt
            ? "Checks paused"
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

  const row = $derived(
    windows && downloading
      ? "updating"
      : manualInstall
        ? "failed"
        : center.rowStatus(key, furthestStatus(own, requested)),
  );

  const actionable = $derived(center.writable && !!worker && desktop?.connected && !desktop.disabledReason);
  const gatewayBusy = $derived(center.writable && center.active);

  const retryLocally = $derived(
    windows && row === "failed" && !ready && status?.phase !== "disabled" && status?.phase !== "checking",
  );

  const error = $derived(
    (windows && status?.error) ||
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
      status?.phase === "disabled" ? status.message : "",
    ]
      .filter(Boolean)
      .join(" "),
  );

  function retry() {
    if (worker && desktop?.phase === "failed" && actionable)
      void center.manage({ action: "desktop", workerId: worker.workerId }, key);
    else void updates.check();
  }
</script>

{#if status}
  <UpdateItem
    name={worker?.name || (bundled ? "This Canopy app" : "This computer")}
    {compact}
    icon="computer-desktop"
    current={status.version}
    {target}
    status={row}
    line={downloading
      ? "Downloading"
      : row === "waiting"
        ? "Restarts after its current turns end."
        : row === "queued" && ready && !worker
          ? "Restarts after the other Canopy updates finish."
          : ""}
    linePercent={downloading ? status.progress : undefined}
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
      {#if manualInstall && compact}
        <IconButton
          icon="folder-open"
          size="sm"
          label="Update manually"
          disabled={!!status.changingChannel || gatewayBusy}
          loading={updates.restarting}
          onclick={() => void updates.run()}
        />
      {:else if !manualInstall && (row === "downloaded" || (ready && (row === "failed" || downloading)))}
        {#if !restartInFooter}
          <IconButton
            icon="power"
            size="sm"
            label="Restart to update"
            tooltipText={status.phase === "checking" || status.phase === "downloading"
              ? "Restart to update after this download. Agents running on this computer stop."
              : "Restart to update. Agents running on this computer stop."}
            disabled={!!status.changingChannel || gatewayBusy}
            loading={updates.restarting}
            onclick={() => void updates.run()}
          />
        {/if}
      {:else if retryLocally && compact}
        <IconButton
          icon="repeat"
          size="sm"
          label="Retry app update"
          disabled={gatewayBusy || !!status.changingChannel}
          loading={updates.pending}
          onclick={() => void updates.check()}
        />
      {:else if row === "failed" && step < 0 && !windows}
        <IconButton
          icon="repeat"
          size="sm"
          label="Retry"
          disabled={gatewayBusy}
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
      {:else if row === "available" && !actionable}
        <IconButton
          icon="arrow-down-tray"
          size="sm"
          label="Download app update"
          disabled={gatewayBusy || !!status.changingChannel || status.phase === "disabled"}
          loading={updates.pending}
          onclick={() => void updates.check()}
        />
      {:else if row === "waiting" && actionable && worker}
        <IconButton
          icon="power"
          size="sm"
          label={`Restart ${worker.name} now…`}
          disabled={center.active}
          onclick={() => (confirming = true)}
        />
      {/if}
    {/snippet}
    {#snippet errorActions()}
      {#if manualInstall}
        <Button
          size="sm"
          class="justify-self-start"
          disabled={gatewayBusy || !!status.changingChannel}
          loading={updates.restarting}
          onclick={() => void updates.run()}>Update manually</Button
        >
      {:else if retryLocally}
        <Button
          size="sm"
          class="justify-self-start"
          disabled={gatewayBusy || !!status.changingChannel}
          loading={updates.pending}
          onclick={() => void updates.check()}>Retry app update</Button
        >
      {/if}
      {#if desktop?.phase === "failed" && (worker || bundled)}
        <Button
          size="sm"
          class="justify-self-start"
          disabled={!center.writable || !!center.pending || center.gatewayTransition}
          onclick={() =>
            void center.manage({
              action: worker ? "desktop_dismiss" : "app_dismiss",
              workerId: worker?.workerId,
              desktopRequestId: desktop?.requestId,
            })}>Dismiss</Button
        >
      {/if}
    {/snippet}
  </UpdateItem>
  {#if !compact}
    <div class="mb-2 ml-6 grid gap-1 text-xs/5 text-muted">
      <p>
        {status.buildChannel} build{bundled ? " · Includes this computer’s gateway and worker." : ""}
      </p>
      {#if info}<p class="break-anywhere">{info}</p>{/if}
      {#if ready && !manualInstall}
        <p>
          {downloading
            ? "Restart waits for the download, then stops agents running on this computer."
            : "Restarting stops the agents running on this computer."}
        </p>
      {/if}
      {#if row !== "failed" && (updates.error || status.error)}<p
          class="break-anywhere text-rose-600 dark:text-rose-400"
          role="status"
        >
          {updates.error || status.error}
        </p>{/if}
    </div>
  {/if}
{:else if !compact && updates.error}<p
    class={["break-anywhere text-sm/5 text-rose-600 dark:text-rose-400", className]}
    role="status"
  >
    {updates.error}
  </p>{/if}
{#if worker}<WorkerRestartConfirmation bind:open={confirming} {worker} updates={center} />{/if}

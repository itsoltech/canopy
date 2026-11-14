<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import UpdateItem from "./UpdateItem.svelte";
  import { computerUpdate } from "@canopy/domain/release/computer-update";
  import { presenceTime } from "#lib/features/computers/computers.ts";
  import type { UpdatesState } from "./updates.svelte.ts";
  import AppUpdateConfirmation from "./AppUpdateConfirmation.svelte";
  import { currentRemoteUpdate } from "@canopy/domain/release/remote-update-state";
  import { updateInProgress, updateTargetKey } from "@canopy/domain/release/update-status";

  let {
    computer,
    updates,
    local = false,
    class: className,
  }: { computer: ui.ComputerUpdate; updates: UpdatesState; local?: boolean; class?: ClassValue } = $props();

  // An announced restart warns only when overdue: the row rechecks the time while it lasts.
  let now = $state(Date.now());

  $effect(() => {
    if (!["updating", "restarting"].includes(computer.presence)) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 15_000);

    return () => clearInterval(timer);
  });

  const view = $derived(computerUpdate(computer, presenceTime, now));
  const app = $derived(computer.updates?.app && currentRemoteUpdate(computer.updates.app));

  const key = $derived(
    local ? updateTargetKey({ kind: "app" }) : updateTargetKey({ kind: "computer", nodeId: computer.nodeId }),
  );

  const status = $derived(updates.rowStatus(key, view.status));
  const step = $derived(updates.failedStep(key));
  const failed = $derived(status === "failed");

  const error = $derived(
    failed ? view.detail || updates.snapshot?.run?.steps[step]?.reason || "The update did not finish." : "",
  );

  // A peer read that is late says so; an announced restart already explains itself.
  const line = $derived(
    view.line || (computer.reason && computer.readState && computer.readState !== "fresh" ? computer.reason : ""),
  );

  const retry = $derived(
    step >= 0
      ? { action: "retry_step", desktopRequestId: updates.snapshot?.run?.id ?? "", updateStepIndex: step }
      : undefined,
  );

  let confirming = $state(false);
</script>

<!-- A computer's Canopy app: its own gateway and worker update with it (docs/updates.md). -->
<UpdateItem
  name={local ? "This computer" : computer.name}
  title={computer.name}
  icon="computer-desktop"
  current={app?.version || computer.version}
  target={view.target}
  {status}
  {line}
  lineTone={view.overdue ? "amber" : undefined}
  {error}
  busy={updateInProgress(status)}
  progress={view.progress}
  class={className}
>
  {#snippet action()}
    {#if failed && (retry || app?.phase === "failed")}
      <IconButton
        icon="repeat"
        size="sm"
        label="Retry"
        disabled={updates.active || computer.presence !== "connected"}
        loading={updates.pending === "retry_step"}
        onclick={() => {
          if (retry && !local) void updates.manage(retry, key);
          else confirming = true;
        }}
      />
    {:else if view.actionable && !updateInProgress(status)}
      <IconButton
        icon={local && status === "downloaded" ? "power" : "arrow-down-tray"}
        size="sm"
        label={local && status === "downloaded" ? "Restart to update" : `Update ${computer.name}`}
        disabled={updates.active || computer.presence !== "connected" || !app?.connected || !!app.disabledReason}
        loading={updates.pending === (local ? "app" : computer.nodeId)}
        onclick={() => (confirming = true)}
      />
    {:else if (view.detail || local) && !failed && !updateInProgress(status)}<IconButton
        icon="information-circle"
        size="sm"
        label={view.detail || "Includes this computer’s gateway and worker."}
        tooltipOptions={{ touch: "tap" }}
      />{/if}
  {/snippet}
  {#snippet errorActions()}
    {#if app?.phase === "failed"}
      <Button
        size="sm"
        class="justify-self-start"
        disabled={!!updates.pending}
        onclick={() =>
          void updates.manage({
            action: local ? "app_dismiss" : "computer_dismiss",
            nodeId: computer.nodeId,
            desktopRequestId: app?.requestId,
          })}>Dismiss</Button
      >
    {/if}
  {/snippet}
</UpdateItem>

<AppUpdateConfirmation bind:open={confirming} {computer} {updates} request={local ? retry : undefined} />

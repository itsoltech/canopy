<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import UpdateItem from "./UpdateItem.svelte";
  import { computerUpdate } from "@canopy/domain/release/computer-update";
  import { updateCheckLabel } from "@canopy/domain/computer-presence";
  import { presenceTime } from "#lib/features/computers/computers.ts";
  import type { UpdatesState } from "./updates.svelte.ts";
  import AppUpdateConfirmation from "./AppUpdateConfirmation.svelte";
  import { currentRemoteUpdate } from "@canopy/domain/release/remote-update-state";
  import { updateInProgress, updateTargetKey } from "@canopy/domain/release/update-status";

  let {
    computer,
    updates,
    local = false,
    compact = false,
    class: className,
  }: {
    computer: ui.ComputerUpdate;
    updates: UpdatesState;
    local?: boolean;
    compact?: boolean;
    class?: ClassValue;
  } = $props();

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

  let confirming = $state(false);
  let checking = $state(false);

  async function check() {
    checking = true;

    try {
      await updates.manage({ action: "computer_check", nodeId: computer.nodeId });
    } finally {
      checking = false;
    }
  }
</script>

<!-- A computer's Canopy app: its own gateway and worker update with it (docs/updates.md). -->
<UpdateItem
  name={computer.name}
  wrapName={compact}
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
    {#if failed && step < 0 && app?.phase === "failed"}
      <IconButton
        icon="repeat"
        size="sm"
        label="Retry"
        disabled={updates.active || computer.presence !== "connected" || !app.connected || !!app.disabledReason}
        onclick={() => (confirming = true)}
      />
    {:else if !failed && view.actionable && !updateInProgress(status)}
      <IconButton
        icon={local && status === "downloaded" ? "power" : "arrow-down-tray"}
        size="sm"
        label={local && status === "downloaded" ? "Restart to update" : `Update ${computer.name}`}
        disabled={updates.active || computer.presence !== "connected" || !app?.connected || !!app.disabledReason}
        loading={updates.pending === (local ? "app" : computer.nodeId)}
        onclick={() => (confirming = true)}
      />
    {/if}
  {/snippet}
  {#snippet errorActions()}
    {#if app?.phase === "failed"}
      <Button
        size="sm"
        class="justify-self-start"
        disabled={!updates.writable || !!updates.pending || updates.gatewayTransition}
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

{#if !compact || (view.detail && !failed && !line)}
  <div class="mb-2 ml-6 grid gap-1 text-xs/5 text-muted">
    {#if !compact && local}<p>Includes this computer’s gateway and worker.</p>{/if}
    {#if view.detail && !failed && !line}<p class="break-anywhere">{view.detail}</p>{/if}
    {#if !compact}
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        {#if app}
          <span class="tabular-nums"
            >{app.channel ? `${app.channel} · ` : ""}{updateCheckLabel(app.lastCheckedAtMs, presenceTime)}</span
          >
        {/if}
        {#if !local && computer.remoteUpdate}
          <Button
            size="sm"
            variant="text"
            aria-label={`Check ${computer.name} for updates`}
            loading={checking}
            disabled={!updates.writable ||
              !!updates.pending ||
              updates.gatewayTransition ||
              computer.presence !== "connected" ||
              !app?.connected}
            onclick={() => void check()}>Check now</Button
          >
        {/if}
      </div>
    {/if}
  </div>
{/if}

<AppUpdateConfirmation bind:open={confirming} {computer} {updates} />

<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import UpdateItem from "./UpdateItem.svelte";
  import { workerCurrent } from "./compact-updates.ts";
  import { updateBusy, updateStateLabel, updateTone, type UpdatesState } from "./updates.svelte.ts";

  let {
    worker,
    updates,
    allowForce = false,
    class: className,
  }: { worker: ui.WorkerUpdate; updates: UpdatesState; allowForce?: boolean; class?: ClassValue } = $props();

  let confirming = $state(false);

  const snapshot = $derived(updates.snapshot);
  const desktop = $derived(worker.desktop);
  const current = $derived(workerCurrent(worker, snapshot?.gatewayVersion ?? ""));

  const busy = $derived(
    updateBusy(worker.state) ||
      ["queued", "checking", "downloading", "waiting_idle", "restarting"].includes(desktop?.phase ?? ""),
  );

  const failed = $derived(worker.state === "failed" || desktop?.phase === "failed");
  const external = $derived(worker.installKind !== "binary" && !desktop);

  const reason = $derived(
    desktop?.disabledReason ||
      desktop?.reason ||
      worker.reason.replace(/^Managed externally\.\s*/, "") ||
      (!worker.connected ? "Update channel offline" : ""),
  );

  const actionable = $derived(
    desktop
      ? desktop.connected &&
          !desktop.disabledReason &&
          !!desktop.availableVersion &&
          desktop.availableVersion !== desktop.version
      : worker.installKind === "binary" &&
          !!snapshot?.admin &&
          !!worker.version &&
          worker.version !== snapshot.gatewayVersion &&
          worker.state !== "ahead",
  );

  const label = $derived(
    external && !current
      ? "Managed externally"
      : current
        ? "Up to date"
        : desktop
          ? ({
              downloading: `${Math.round(desktop.progress)}%`,
              waiting_idle: "Waiting for idle",
              restarting: "Restarting",
              failed: "Failed",
              checking: "Checking",
              queued: "Queued",
            }[desktop.phase] ?? (actionable ? "Available" : "Unavailable"))
          : busy || failed || ["managed_externally", "ahead"].includes(worker.state)
            ? updateStateLabel(worker.state, worker.compatibility === "compatible")
            : actionable
              ? "Available"
              : "Unavailable",
  );
</script>

<UpdateItem
  name={worker.name}
  icon={desktop ? "computer-desktop" : "server"}
  current={desktop?.version || worker.version}
  target={desktop?.targetVersion ||
    desktop?.availableVersion ||
    (worker.state !== "ahead" ? snapshot?.gatewayVersion : "")}
  status={label}
  tone={updateTone({ failed, busy, current })}
  detail={reason}
  error={failed ? reason : ""}
  {busy}
  progress={desktop?.phase === "downloading" ? desktop.progress : undefined}
  class={className}
>
  {#snippet action()}
    {#if actionable && !busy && !current}
      <IconButton
        icon="arrow-up"
        size="sm"
        label={`Update ${worker.name}`}
        disabled={!!updates.pending || snapshot?.run?.state === "running"}
        loading={updates.pending === worker.workerId}
        onclick={() => void updates.manage({ action: desktop ? "desktop" : "worker", workerId: worker.workerId })}
      />
    {:else if allowForce && desktop?.phase === "waiting_idle" && desktop.connected && !desktop.disabledReason}
      <IconButton
        icon="arrow-path"
        size="sm"
        label={`Restart ${worker.name} now…`}
        disabled={!!updates.pending || snapshot?.run?.state === "running"}
        onclick={() => (confirming = true)}
      />
    {:else if reason}<IconButton
        icon="information-circle"
        size="sm"
        label={reason}
        tooltipOptions={{ touch: "tap" }}
      />{/if}
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

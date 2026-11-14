<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import UpdateItem from "./UpdateItem.svelte";
  import { gatewayCurrent } from "./compact-updates.ts";
  import type { UpdatesState } from "./updates.svelte.ts";
  import { isRateLimitMessage } from "@canopy/domain/release/http";
  import { updateInProgress, updateTargetKey, type UpdateStatus } from "@canopy/domain/release/update-status";

  let { updates, class: className }: { updates: UpdatesState; class?: ClassValue } = $props();
  const snapshot = $derived(updates.snapshot);
  const current = $derived(!!snapshot && gatewayCurrent(snapshot));
  const external = $derived(snapshot?.gatewayInstallKind !== "binary");
  const reason = $derived(snapshot?.gatewayReason.replace(/^Managed externally\.\s*/, "") ?? "");
  const key = updateTargetKey({ kind: "gateway" });

  const PHASE = new Map<string, UpdateStatus>([
    ["queued", "queued"],
    ["waiting_idle", "waiting"],
    ["downloading", "updating"],
    ["restarting", "restarting"],
    ["failed", "failed"],
  ]);

  // A feed check keeps the settled word; the header shows the check.
  const own = $derived(
    !snapshot
      ? "current"
      : (PHASE.get(snapshot.gatewayState) ??
          (isRateLimitMessage(snapshot.checkError)
            ? "Checks paused"
            : external && snapshot.gatewayUpdateAvailable
              ? "Managed externally"
              : current
                ? "current"
                : snapshot.gatewayUpdateAvailable
                  ? "available"
                  : snapshot.checking
                    ? "current"
                    : "Not checked")),
  );

  const status = $derived(updates.rowStatus(key, own));
  const step = $derived(updates.failedStep(key));
  const inProgress = $derived(updateInProgress(status));
</script>

{#if snapshot}
  <UpdateItem
    name="Gateway"
    icon="server"
    current={snapshot.gatewayVersion}
    target={snapshot.gatewayUpdateAvailable ? snapshot.availableVersion : ""}
    {status}
    line={isRateLimitMessage(snapshot.checkError)
      ? snapshot.checkError
      : status === "waiting"
        ? "Restarts after its current turns end."
        : ""}
    error={status === "failed" ? reason || snapshot.run?.steps[step]?.reason || "The gateway update failed." : ""}
    busy={inProgress}
    class={className}
  >
    {#snippet action()}
      {#if !external && status === "failed"}
        <IconButton
          size="sm"
          icon="repeat"
          label="Retry"
          disabled={updates.active || !snapshot.admin}
          onclick={() => {
            const run = snapshot.run;

            if (step >= 0 && run)
              void updates.manage({ action: "retry_step", desktopRequestId: run.id, updateStepIndex: step }, key);
            else void updates.manage({ action: "gateway" }, key);
          }}
        />
      {:else if !external && snapshot.gatewayUpdateAvailable && !inProgress}
        <IconButton
          size="sm"
          icon="arrow-down-tray"
          label="Update gateway"
          disabled={updates.active || !snapshot.admin}
          onclick={() => void updates.manage({ action: "gateway" }, key)}
        />
      {:else if reason && !inProgress}<IconButton
          size="sm"
          icon="information-circle"
          label={reason}
          tooltipOptions={{ touch: "tap" }}
        />{/if}
    {/snippet}
  </UpdateItem>
{/if}

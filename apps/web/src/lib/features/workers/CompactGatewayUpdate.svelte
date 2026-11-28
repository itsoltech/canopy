<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import UpdateItem from "./UpdateItem.svelte";
  import { gatewayCurrent } from "./compact-updates.ts";
  import type { UpdatesState } from "./updates.svelte.ts";
  import { isRateLimitMessage } from "@canopy/domain/release/http";
  import {
    binaryUpdateDetail,
    binaryUpdateStatus,
    gatewayRowTarget,
    gatewayUpdateLifecycle,
    updateInProgress,
    updateTargetKey,
  } from "@canopy/domain/release/update-status";

  let {
    updates,
    compact = false,
    class: className,
  }: { updates: UpdatesState; compact?: boolean; class?: ClassValue } = $props();

  const snapshot = $derived(updates.snapshot);
  const current = $derived(!!snapshot && gatewayCurrent(snapshot));
  const external = $derived(snapshot?.gatewayInstallKind !== "binary");
  const reason = $derived(snapshot?.gatewayReason.replace(/^Managed externally\.\s*/, "") ?? "");
  const key = updateTargetKey({ kind: "gateway" });
  const phase = $derived(binaryUpdateStatus(snapshot?.gatewayState ?? ""));

  // A feed check keeps the settled word; the header shows the check.
  const own = $derived(
    !snapshot
      ? "current"
      : (phase ??
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

  const status = $derived(
    gatewayUpdateLifecycle(snapshot?.gatewayState)
      ? own
      : updates.gatewayTransition
        ? "Unavailable"
        : updates.rowStatus(key, own),
  );

  const step = $derived(updates.failedStep(key));
  const inProgress = $derived(updateInProgress(status));
</script>

{#if snapshot}
  <UpdateItem
    name="Gateway"
    {compact}
    icon="server"
    current={snapshot.gatewayVersion}
    target={updates.gatewayTransition ? "" : gatewayRowTarget(snapshot)}
    {status}
    line={status === phase
      ? binaryUpdateDetail(snapshot.gatewayState)
      : !updates.gatewayTransition && isRateLimitMessage(snapshot.checkError)
        ? snapshot.checkError
        : ""}
    error={status === "failed" ? reason || snapshot.run?.steps[step]?.reason || "The gateway update failed." : ""}
    busy={inProgress}
    progress={status === "downloading" ? snapshot.gatewayDownloadProgress : undefined}
    class={className}
  >
    {#snippet action()}
      {#if !updates.gatewayTransition && !external && status === "failed" && step < 0 && snapshot.gatewayUpdateAvailable}
        <IconButton
          size="sm"
          icon="repeat"
          label="Retry"
          disabled={updates.active || !snapshot.admin}
          onclick={() => void updates.manage({ action: "gateway" }, key)}
        />
      {:else if !updates.gatewayTransition && !external && status === "available"}
        <IconButton
          size="sm"
          icon="arrow-down-tray"
          label="Update gateway"
          disabled={updates.active || !snapshot.admin}
          onclick={() => void updates.manage({ action: "gateway" }, key)}
        />
      {:else if !updates.gatewayTransition && reason && !inProgress}<IconButton
          size="sm"
          icon="information-circle"
          label={reason}
          tooltipOptions={{ touch: "tap" }}
        />{/if}
    {/snippet}
  </UpdateItem>
{/if}

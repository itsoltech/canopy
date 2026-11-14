<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import UpdateItem from "#lib/features/workers/UpdateItem.svelte";
  import type { UpdatesState } from "#lib/features/workers/updates.svelte.ts";
  import type { DesktopUpdatesState } from "./desktop-updates.svelte.ts";
  import { updateInProgress, updateTargetKey } from "@canopy/domain/release/update-status";

  let {
    updates,
    center,
    bundled = false,
    class: className,
  }: {
    updates: DesktopUpdatesState;
    /** The update center: while Update all runs, this computer restarts last, by the run, never from its row. */
    center: UpdatesState;
    /** The gateway reports itself as this app's bundled one (local mode): the app includes it and its worker. */
    bundled?: boolean;
    class?: ClassValue;
  } = $props();

  const status = $derived(updates.status);
  const ready = $derived(!!status?.stagedVersion || status?.phase === "downloaded");

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
                  : status.updateVersion
                    ? "available"
                    : "current",
  );

  const row = $derived(center.rowStatus(updateTargetKey({ kind: "app" }), own));

  const info = $derived(
    [
      status?.publishing || (status?.retryAt ? status.message : ""),
      bundled ? "Includes this computer’s gateway and worker." : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
</script>

{#if status}
  <UpdateItem
    name="This computer"
    title="This computer’s Canopy app"
    icon="computer-desktop"
    current={status.version}
    target={status.stagedVersion || status.updateVersion}
    status={row}
    line={row === "queued" && ready ? "Restarts last, after the others." : ""}
    error={row === "failed" ? updates.error || status.error || status.message || "The app update failed." : ""}
    busy={updateInProgress(row)}
    progress={status.phase === "downloading" ? status.progress : undefined}
    class={className}
  >
    {#snippet action()}
      {#if row === "downloaded"}
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
      {:else if row === "failed" && status.phase === "error"}
        <IconButton
          icon="repeat"
          size="sm"
          label="Retry"
          disabled={center.active}
          loading={updates.pending}
          onclick={() => void updates.check()}
        />
      {:else if info && !updateInProgress(row)}<IconButton
          icon="information-circle"
          size="sm"
          label={info}
          tooltipOptions={{ touch: "tap" }}
        />{/if}
    {/snippet}
  </UpdateItem>
{:else if updates.error}<p
    class={["break-anywhere text-sm/5 text-rose-600 dark:text-rose-400", className]}
    role="status"
  >
    {updates.error}
  </p>{/if}

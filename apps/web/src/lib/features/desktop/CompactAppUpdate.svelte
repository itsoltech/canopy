<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import UpdateItem from "#lib/features/workers/UpdateItem.svelte";
  import { updateTone } from "#lib/features/workers/updates.svelte.ts";
  import { appCurrent } from "#lib/features/workers/compact-updates.ts";
  import type { DesktopUpdatesState } from "./desktop-updates.svelte.ts";
  import { updateCheckLabel } from "@canopy/domain/computer-presence";
  import { presenceTime } from "#lib/features/computers/computers.ts";

  let {
    updates,
    bundled = false,
    class: className,
  }: {
    updates: DesktopUpdatesState;
    /** The gateway reports itself as this app's bundled one (local mode): the app includes it and its worker. */
    bundled?: boolean;
    class?: ClassValue;
  } = $props();

  const status = $derived(updates.status);
  const ready = $derived(!!status?.stagedVersion || status?.phase === "downloaded");

  const busy = $derived(
    updates.pending || !!status?.changingChannel || ["checking", "downloading"].includes(status?.phase ?? ""),
  );

  // Check now in the header also checks the app, so a settled row explains what it includes instead.
  const info = $derived(
    bundled && !ready && !["downloaded", "error"].includes(status?.phase ?? "")
      ? [status?.publishing || status?.message, "Includes this computer’s gateway and worker."]
          .filter(Boolean)
          .join(" ")
      : "",
  );
</script>

{#if status}
  <UpdateItem
    name="This Canopy app"
    icon="computer-desktop"
    current={status.version}
    target={status.updateVersion}
    metadata={updateCheckLabel(status.lastCheckedAt, presenceTime)}
    status={status.phase === "downloaded"
      ? "Ready"
      : status.retryAt
        ? "Checks paused"
        : status.phase === "downloading"
          ? `${Math.round(status.progress ?? 0)}%`
          : status.phase === "checking"
            ? "Checking"
            : status.phase === "error"
              ? "Failed"
              : status.phase === "disabled"
                ? "Disabled"
                : status.publishing
                  ? "Publishing"
                  : status.updateVersion
                    ? "Available"
                    : "Up to date"}
    tone={updateTone({
      failed: status.phase === "error",
      busy,
      current: status.phase === "downloaded" || appCurrent(status),
    })}
    detail={status.publishing || status.message}
    notice={status.retryAt ? status.publishing || status.message : ""}
    error={updates.error || status.error || (status.phase === "error" ? status.message : "")}
    {busy}
    progress={status.phase === "downloading" ? status.progress : undefined}
    class={className}
  >
    {#snippet action()}
      {#if info}<IconButton
          icon="information-circle"
          size="sm"
          label={info}
          tooltipOptions={{ touch: "tap" }}
        />{:else}<IconButton
          icon={ready ? "arrow-up" : "arrow-path"}
          size="sm"
          label={ready
            ? status.phase === "checking" || status.phase === "downloading"
              ? "Restart after this download. This stops agents running on this computer."
              : "Restart to update Canopy. This stops agents running on this computer."
            : status.publishing || status.message || "Check for app updates"}
          disabled={ready ? !!status.changingChannel || updates.restarting : busy || status.phase === "disabled"}
          loading={ready ? updates.restarting : updates.pending}
          onclick={() => void updates.run()}
        />{/if}
    {/snippet}
  </UpdateItem>
{:else if updates.error}<p
    class={["break-anywhere text-sm/5 text-rose-600 dark:text-rose-400", className]}
    role="status"
  >
    {updates.error}
  </p>{/if}

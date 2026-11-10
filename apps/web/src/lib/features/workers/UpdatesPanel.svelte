<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import ReleaseChannelField from "./ReleaseChannelField.svelte";
  import UpdateRows from "./UpdateRows.svelte";
  import { DesktopUpdatesState } from "#lib/features/desktop/desktop-updates.svelte.ts";
  import UpdateRun from "./UpdateRun.svelte";
  import { updateCenter, UpdatesState, updateBusy } from "./updates.svelte.ts";
  import TextLink from "#lib/shared/ui/TextLink.svelte";
  import { listedWorkers, updatesAvailable } from "./compact-updates.ts";
  import { updateIndicator } from "./update-indicator.ts";
  import { isRateLimitMessage } from "@canopy/domain/release/http";

  let {
    class: className,
    fixture,
  }: {
    class?: ClassValue;
    /** Development fixtures (/dev/updates): fixed state, no polling. */
    fixture?: { updates: UpdatesState; app: DesktopUpdatesState };
  } = $props();

  const given = untrack(() => fixture);
  const updates = given?.updates ?? updateCenter;
  const app = given?.app ?? new DesktopUpdatesState();
  const overview = useOverview();
  const snapshot = $derived(updates.snapshot);
  const busy = $derived(updateBusy(snapshot?.gatewayState ?? "") || snapshot?.run?.state === "running");
  const summary = $derived(updateIndicator(undefined, snapshot, updates.error, updates.pending));
  const available = $derived(!!snapshot && updatesAvailable(snapshot));

  const checked = $derived.by(() => {
    const at = Date.parse(snapshot?.checkedAt ?? "");

    if (!Number.isFinite(at)) return "Not checked yet";
    const minutes = Math.max(0, Math.floor((clock.now - at) / 60000));

    return minutes < 1
      ? "Checked just now"
      : `Checked ${minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr`} ago`;
  });

  const status = $derived(
    summary.phase === "quiet"
      ? "All up to date"
      : summary.phase === "error"
        ? "Update failed"
        : summary.phase === "available"
          ? "Updates available"
          : summary.message,
  );

  onMount(() => {
    const unsubscribe = overview.subscribe((update) => {
      if (update.change.case === "desktopUpdate" && updates.snapshot) {
        const value = update.change.value;
        const worker = updates.snapshot.workers.find((w) => w.workerId === value.workerId);

        if (worker) worker.desktop = value;
      }
    });

    if (given) return unsubscribe;
    const off = app.connect();
    const stop = updates.poll();

    return () => {
      stop();
      unsubscribe();
      off?.();
    };
  });
</script>

<SettingsGroup title="Updates" class={className}>
  <div class="flex min-w-0 flex-wrap items-center justify-between gap-2 px-3 py-2">
    <div class="min-w-0 text-sm/5" role="status">
      <p class="font-medium">{status}</p>
      <p class="text-xs/5 text-muted" title={snapshot?.checkedAt}>{checked}</p>
    </div>
    <div class="flex shrink-0 items-center gap-1">
      <IconButton
        size="sm"
        icon="information-circle"
        label="Update all skips externally managed items. It updates the gateway, binary workers, native agent CLIs, then Canopy apps. Linked computers update last, one at a time."
      />
      <Button
        size="sm"
        disabled={!!updates.pending || busy || snapshot?.checking}
        loading={updates.pending === "check" || snapshot?.checking}
        onclick={() =>
          void (snapshot?.admin || snapshot?.gatewayBundled ? updates.manage({ action: "check" }) : updates.reload())}
        >Check now</Button
      >
      {#if available}<Button
          size="sm"
          disabled={!!updates.pending || busy}
          loading={snapshot?.run?.state === "running"}
          onclick={() => void updates.manage({ action: "update_all" })}>Update all</Button
        >{/if}
    </div>
  </div>
  {#if updates.error || snapshot?.checkError}<div class="p-3">
      <Alert tone={isRateLimitMessage(updates.error || snapshot?.checkError || "") ? "info" : "error"}
        >{updates.error || snapshot?.checkError}</Alert
      >
    </div>{/if}
  {#if snapshot}
    {#if snapshot.gatewayBundled}<p class="px-3 py-2 text-sm/5 text-pretty text-muted">
        This computer’s gateway and worker update with the Canopy app in <TextLink href="/settings/app-updates"
          >App updates</TextLink
        >.
      </p>{/if}
    <!-- The popover's rows (UpdateRows): computers, workers by computer, agent CLIs by computer. -->
    <div class="min-w-0 px-3">
      <UpdateRows {updates} {app} allowForce>
        {#snippet gateway()}<ReleaseChannelField
            current={snapshot.channel}
            version={snapshot.gatewayVersion}
            disabled={!snapshot.admin || !!updates.pending || busy}
            pending={updates.pending === "channel"}
            onsave={(channel) => updates.manage({ action: "channel", channel })}
            class="-mx-3"
          />{/snippet}
      </UpdateRows>
    </div>
    {#if !snapshot.gatewayBundled && !listedWorkers(snapshot).length && !snapshot.computers.length}<p
        class="px-3 py-2 text-sm/5 text-muted"
      >
        No workers yet
      </p>{/if}
    {#if snapshot.run && (snapshot.run.steps.length || snapshot.run.state === "running" || snapshot.run.reason)}<UpdateRun
        run={snapshot.run}
        class="px-3 py-2"
      />{/if}
  {:else}<p class="px-3 py-2 text-sm/5 text-muted" role="status">Loading update status…</p>{/if}
</SettingsGroup>

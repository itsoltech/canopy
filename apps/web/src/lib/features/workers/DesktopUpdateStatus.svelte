<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import ProgressBar from "#lib/shared/ui/ProgressBar.svelte";

  let {
    state: update,
    pending,
    disabled = false,
    onupdate,
    onforce,
    class: className,
  }: {
    state: ui.DesktopUpdateState;
    pending: boolean;
    disabled?: boolean;
    onupdate(): void;
    onforce(): void;
    class?: ClassValue;
  } = $props();

  let confirming = $state(false);
  const busy = $derived(["queued", "checking", "downloading", "waiting_idle", "restarting"].includes(update.phase));
  const reason = $derived(update.disabledReason || (!update.connected ? "Desktop app is offline." : ""));

  const label = $derived(
    {
      idle: "Ready",
      queued: "Requested",
      checking: "Checking for updates",
      downloading: `Downloading ${Math.round(update.progress)}%`,
      waiting_idle: "Waiting for idle",
      restarting: "Restarting",
      failed: "Failed",
      succeeded: "Updated",
    }[update.phase] ?? "Unavailable",
  );
</script>

<div class={["grid gap-3", className]}>
  <div class="flex flex-wrap items-center gap-2">
    <Badge tone={update.phase === "failed" ? "rose" : busy ? "amber" : "neutral"}>{label}</Badge>
    <p class="text-base/6 text-zinc-500 tabular-nums sm:text-sm/6 dark:text-zinc-400">
      Canopy app {update.version || "version unknown"}{update.channel ? ` · ${update.channel}` : ""}
      {update.availableVersion ? ` · Available: ${update.availableVersion}` : ""}
    </p>
  </div>
  {#if update.phase === "downloading"}<ProgressBar value={update.progress} label="Downloading Canopy app" />{/if}
  <p class="text-base/6 text-pretty break-words text-zinc-500 sm:text-sm/6 dark:text-zinc-400" role="status">
    {reason ||
      (update.phase === "waiting_idle" ? "Will restart after the current turns." : update.reason) ||
      "Updates the entire app using this desktop’s update channel."}
  </p>
  <div class="flex flex-wrap gap-2">
    <Button size="sm" disabled={disabled || pending || busy || !!reason} loading={pending} onclick={onupdate}
      >Update Canopy app</Button
    >
    {#if update.phase === "waiting_idle"}
      <Button size="sm" disabled={disabled || pending || !!reason} onclick={() => (confirming = true)}
        >Restart now…</Button
      >
    {/if}
  </div>
</div>
<Dialog bind:open={confirming} title="Restart Canopy app now?">
  <div class="grid gap-5">
    <p class="text-base/6 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
      Restarting stops the running turns on this computer. The app reconnects by itself.
    </p>
    <div class="flex flex-wrap justify-end gap-2">
      <Button size="sm" onclick={() => (confirming = false)}>Keep waiting</Button>
      <Button
        size="sm"
        variant="primary"
        disabled={disabled || pending || !!reason}
        onclick={() => {
          confirming = false;
          onforce();
        }}>Restart now</Button
      >
    </div>
  </div>
</Dialog>

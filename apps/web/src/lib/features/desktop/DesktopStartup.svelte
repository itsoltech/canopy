<script lang="ts">
  import type { DesktopStatus } from "@canopy/ui/desktop";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import ProgressBar from "#lib/shared/ui/ProgressBar.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";

  let {
    status,
    message,
    retrying,
    onretry,
  }: { status?: DesktopStatus; message: string; retrying: boolean; onretry: () => void } = $props();

  const failed = $derived(!retrying && (Boolean(message) || status?.phase === "error"));

  const line = $derived(
    status?.database?.message ??
      (status?.mode === "remote" && status.gatewayUrl
        ? `Connecting to ${new URL(status.gatewayUrl).host}…`
        : "Starting Canopy…"),
  );
</script>

<div class="mx-auto grid w-full max-w-md gap-6 px-6 sm:px-10">
  <img src="/icon-192.png" alt="" width="64" height="64" class="size-16" />
  <div class="grid gap-3">
    <h1 class="text-3xl font-semibold tracking-tight">Canopy</h1>
    {#if failed}
      <Alert
        tone="error"
        title={status?.needsPairing
          ? "Connect this app securely"
          : status?.mode === "remote"
            ? "Gateway unavailable"
            : "Canopy could not start"}
      >
        {message || status?.error}
      </Alert>
      <div class="flex flex-wrap gap-3">
        {#if status?.mode}<Button variant="primary" onclick={onretry}>Try again</Button>{/if}
        <Button onclick={() => window.canopyDesktop?.openSettings()}>Open desktop settings</Button>
      </div>
    {:else}
      <p role="status" class="flex items-center gap-3 text-base/7 text-zinc-500 dark:text-zinc-400">
        <Spinner />{line}
      </p>
      {#if status?.database?.phase === "downloading"}
        <ProgressBar label="PostgreSQL download" value={status.database.progress} />
      {/if}
    {/if}
  </div>
</div>

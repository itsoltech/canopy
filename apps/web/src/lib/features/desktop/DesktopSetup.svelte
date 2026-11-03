<script lang="ts">
  import { onMount } from "svelte";
  import type { DesktopMode, DesktopStatus } from "@canopy/ui/desktop";
  import Button from "#lib/shared/ui/Button.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import ModeChoice from "./ModeChoice.svelte";
  import WorkerStatus from "./WorkerStatus.svelte";
  import AppUpdates from "./AppUpdates.svelte";
  let mode = $state<DesktopMode>("local");
  let status = $state<DesktopStatus>();
  let available = $state(false);
  let busy = $state(false);
  let message = $state("");
  let gatewayUrl = $state("");
  let webUrl = $state("");
  let enrollmentToken = $state("");
  let allowNetwork = $state(false);
  let bindHost = $state("127.0.0.1");
  let revealed = $state(false);
  onMount(() => {
    revealed = true;
    const bridge = window.canopyDesktop;
    if (!bridge) return;
    available = true;
    void bridge.status().then((value) => {
      status = value; mode = value.mode ?? "local"; allowNetwork = value.allowNetwork; bindHost = value.bindHost;
      if (value.mode === "remote") { gatewayUrl = value.gatewayUrl ?? ""; webUrl = value.webUrl ?? ""; }
    }).then(() => bridge.readyForEnrollment());
    const offStatus = bridge.onStatus((value) => { status = value; });
    const offEnrollment = bridge.onEnrollment((value) => { mode = "remote"; gatewayUrl = value.gatewayUrl; webUrl = value.webUrl; enrollmentToken = value.enrollmentToken; });
    return () => { offStatus(); offEnrollment(); };
  });
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!window.canopyDesktop || busy) return;
    busy = true; message = "";
    try {
      await window.canopyDesktop.configure(mode === "local" ? { mode, allowNetwork, bindHost } : { mode, gatewayUrl, webUrl, ...(enrollmentToken.trim() && { enrollmentToken: enrollmentToken.trim() }) });
      enrollmentToken = "";
    } catch (error) { message = error instanceof Error ? error.message : "Canopy could not connect. Check the addresses and try again."; }
    finally { busy = false; }
  }
</script>

<svelte:head><title>Set up Canopy</title></svelte:head>
<!-- On macOS the window has no title bar: the top of the screen moves it (routes/layout.css). -->
<div class="fixed inset-x-0 top-0 hidden h-12 macos:block" data-window-drag></div>
<main class="isolate flex min-h-dvh items-center bg-white py-12 text-zinc-950 dark:bg-black dark:text-white">
  <div class="mx-auto grid w-full max-w-2xl gap-8 px-6 sm:px-10">
    <div class="grid gap-3">
      <img src="/icon-192.png" alt="" width="48" height="48" class="size-12 shrink-0" />
      <h1 class="text-3xl font-semibold tracking-tight text-balance">Your agents, on your terms</h1>
      <p class="text-base/7 text-pretty text-zinc-500 dark:text-zinc-400">Run Canopy here, or bring this computer to your existing gateway.</p>
    </div>
    {#if !available}
      <Alert title="Open Canopy Desktop">This screen is available in the Canopy desktop app.</Alert>
    {:else}
      <form onsubmit={submit} class="grid gap-6">
        <div class="grid gap-3 sm:grid-cols-2" aria-label="Canopy mode">
          <ModeChoice title="Run Canopy on this computer" description="A private gateway, database and worker. Everything is included." icon="server" selected={mode === "local"} onclick={() => (mode = "local")} disabled={busy} />
          <ModeChoice title="Connect to a Canopy gateway" description="Add this computer as a worker and open your existing Canopy." icon="link" selected={mode === "remote"} onclick={() => (mode = "remote")} disabled={busy} />
        </div>
        <div class="t-panel-slide grid gap-5 [--panel-translate-y:12px]" data-open={revealed}>
          {#if mode === "remote"}
            <Field label="Gateway address" description="The gRPC address from Settings → Workers → Add worker."><Input name="gateway" type="url" placeholder="https://gateway.example.com:7443" bind:value={gatewayUrl} required disabled={busy} /></Field>
            <Field label="Canopy web address"><Input name="web" type="url" placeholder="https://canopy.example.com" bind:value={webUrl} required disabled={busy} /></Field>
            <Field label="Enrollment token" description="A one-time token from Settings → Workers → Add worker. Leave empty to reconnect an enrolled worker."><Input name="token" type="password" autocomplete="off" bind:value={enrollmentToken} disabled={busy} /></Field>
          {:else}
            <label class="flex items-start gap-3 text-base/6 sm:text-sm/6"><Input name="allow-network" type="checkbox" choice checked={allowNetwork} onchange={(event) => { allowNetwork = event.currentTarget.checked; if (allowNetwork && bindHost === "127.0.0.1") bindHost = ""; }} disabled={busy} /><span>Allow other machines to connect</span></label>
            {#if allowNetwork}
              <Field label="Network interface address" description="An IPv4 address of this computer on a trusted private network. Only the worker gRPC port is exposed."><Input name="interface" placeholder="100.x.x.x" bind:value={bindHost} required disabled={busy} /></Field>
              <Alert tone="warning">Worker traffic uses HTTP on this interface. Use a trusted private network or configure TLS before exposing the gateway publicly.</Alert>
            {:else}
              <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Your data stays on this computer. No database installation or account is needed.</p>
            {/if}
          {/if}
          {#if message || status?.error}<Alert tone="error">{message || status?.error}</Alert>{/if}
          {#if busy}<p role="status" class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">{status?.phase === "starting" ? "Starting services and connecting your worker…" : "Preparing Canopy…"}</p>{/if}
          <div class="flex flex-wrap items-center gap-3"><Button variant="primary" type="submit" loading={busy}>{status?.mode ? "Save and open Canopy" : "Open Canopy"}</Button></div>
        </div>
      </form>
      {#if status?.mode}<div class="grid gap-3 border-t border-zinc-950/5 pt-6 dark:border-white/10"><WorkerStatus {status} /><p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Saving these settings restarts this computer’s services and stops its running agents.</p></div>{/if}
      <AppUpdates />
    {/if}
  </div>
</main>

<style>
  :global(:root) { --panel-open-dur: 400ms; --panel-close-dur: 350ms; --panel-translate-y: 100px; --panel-blur: 2px; --panel-ease: cubic-bezier(0.22, 1, 0.36, 1); }
  .t-panel-slide { transform: translateY(var(--panel-translate-y)); opacity: 0; filter: blur(var(--panel-blur)); pointer-events: none; transition: transform var(--panel-close-dur) var(--panel-ease), opacity var(--panel-close-dur) var(--panel-ease), filter var(--panel-close-dur) var(--panel-ease); will-change: transform, opacity, filter; }
  .t-panel-slide[data-open="true"] { transform: translateY(0); opacity: 1; filter: blur(0); pointer-events: auto; transition: transform var(--panel-open-dur) var(--panel-ease), opacity var(--panel-open-dur) var(--panel-ease), filter var(--panel-open-dur) var(--panel-ease); will-change: transform, opacity, filter; }
  @media (prefers-reduced-motion: reduce) { .t-panel-slide { transition: none !important; } }
</style>

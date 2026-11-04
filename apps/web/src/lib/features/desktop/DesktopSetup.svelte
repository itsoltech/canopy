<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import {
    sameDesktopConfiguration,
    type DesktopConfiguration,
    type DesktopMode,
    type DesktopStatus,
  } from "@canopy/ui/desktop";
  import Button from "#lib/shared/ui/Button.svelte";
  import RemoteGatewayFields from "./RemoteGatewayFields.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import ModeChoice from "./ModeChoice.svelte";
  import DesktopStartup from "./DesktopStartup.svelte";
  import { rise } from "#lib/shared/ui/motion.ts";

  let { settings = false }: { settings?: boolean } = $props();

  let mode = $state<DesktopMode>("local");
  let status = $state<DesktopStatus>();
  let available = $state<boolean>();
  let busy = $state(false);
  const working = $derived(busy || (!settings && status?.phase === "starting"));

  const startup = $derived(
    available !== false && (!status || (!settings && (busy || status.mode !== null || status.phase !== "setup"))),
  );

  let message = $state("");
  let gatewayUrl = $state("");
  let pairingInvitation = $state("");
  let workerGatewayUrl = $state<string>();
  let enrollmentToken = $state("");
  let gatewayFingerprint = $state("");
  const canGoBack = $derived(settings && Boolean(status?.configuration));

  const selection = $derived<DesktopConfiguration>(
    mode === "local"
      ? { mode, allowNetwork: false, bindHost: "127.0.0.1" }
      : {
          mode,
          gatewayUrl,
          gatewayFingerprint,
          pairingInvitation,
          ...(workerGatewayUrl && { workerGatewayUrl }),
          ...(enrollmentToken.trim() && { enrollmentToken: enrollmentToken.trim() }),
        },
  );

  const unchanged = $derived(sameDesktopConfiguration(selection, status?.configuration));

  async function back() {
    if (!canGoBack || busy) return;

    if (window.canopyDesktop?.closeSettings) await window.canopyDesktop.closeSettings();
    else await goto("/settings/desktop");
  }

  onMount(() => {
    const bridge = window.canopyDesktop;
    available = Boolean(bridge);

    if (!bridge) return;
    void bridge
      .status()
      .then((value) => {
        status = value;
        const saved = value.configuration;
        mode = saved?.mode ?? value.mode ?? "local";

        if (saved?.mode === "remote" || value.mode === "remote") {
          gatewayUrl = saved?.mode === "remote" ? saved.gatewayUrl : (value.gatewayUrl ?? "");
          workerGatewayUrl = saved?.mode === "remote" ? saved.workerGatewayUrl : value.workerGatewayUrl;
        }
      })
      .then(() => bridge.readyForEnrollment())
      .catch(() => {
        message = "Desktop status is unavailable. Restart Canopy to try again.";
      });

    const offStatus = bridge.onStatus((value) => {
      status = value;
    });

    const offEnrollment = bridge.onEnrollment((value) => {
      mode = "remote";
      gatewayUrl = value.gatewayUrl;
      gatewayFingerprint = value.gatewayFingerprint ?? "";
      enrollmentToken = value.enrollmentToken;
    });

    return () => {
      offStatus();
      offEnrollment();
    };
  });

  async function submit(event?: SubmitEvent) {
    event?.preventDefault();

    if (!window.canopyDesktop || working) return;

    if (canGoBack && unchanged) {
      await back();

      return;
    }

    busy = true;
    message = "";

    try {
      const saved = await window.canopyDesktop.configure(selection);

      if (saved === false) return;
      enrollmentToken = "";
      pairingInvitation = "";
    } catch (error) {
      message = error instanceof Error ? error.message : "Canopy could not connect. Check the addresses and try again.";
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>{startup ? "Starting Canopy" : "Set up Canopy"}</title></svelte:head>
<svelte:window
  onkeydown={(event) => {
    if (event.key !== "Escape" || event.defaultPrevented || !canGoBack || busy) return;
    event.preventDefault();
    void back();
  }}
/>
<!-- On macOS the window has no title bar: the top of the screen moves it (routes/layout.css). -->
<div class="fixed inset-x-0 top-0 hidden h-12 macos:block" data-window-drag></div>
<main
  class="isolate flex min-h-dvh items-center bg-white pt-[max(3rem,var(--window-safe-top))] pb-12 text-zinc-950 dark:bg-black dark:text-white"
>
  {#if startup}
    <DesktopStartup {status} {message} retrying={busy} onretry={() => void submit()} />
  {:else}
    <div class="mx-auto grid w-full max-w-2xl gap-8 px-6 sm:px-10">
      {#if canGoBack}
        <div>
          <Button variant="ghost" icon="arrow-left" onclick={() => void back()} disabled={busy}>Back to Settings</Button
          >
        </div>
      {/if}
      <div class="grid gap-3">
        <img src="/icon-192.png" alt="" width="48" height="48" class="size-12 shrink-0" />
        <h1 class="text-3xl font-semibold tracking-tight text-balance">Your agents, on your terms</h1>
        <p class="text-base/7 text-pretty text-zinc-500 dark:text-zinc-400">
          Run Canopy here, or bring this computer to your existing gateway.
        </p>
      </div>
      {#if !available}
        <Alert title="Open Canopy Desktop">This screen is available in the Canopy desktop app.</Alert>
      {:else}
        <form onsubmit={submit} class="grid gap-6">
          <div class="grid gap-3 sm:grid-cols-2" aria-label="Canopy mode">
            <ModeChoice
              title="Run Canopy on this computer"
              description="A private gateway and worker. Downloads PostgreSQL once for local mode."
              icon="server"
              selected={mode === "local"}
              onclick={() => (mode = "local")}
              disabled={working}
            />
            <ModeChoice
              title="Connect to a Canopy gateway"
              description="Use your gateway with this app’s local frontend and a separate worker link."
              icon="link"
              selected={mode === "remote"}
              onclick={() => (mode = "remote")}
              disabled={working}
            />
          </div>
          <div class="grid gap-5" in:rise>
            {#if mode === "remote"}
              <RemoteGatewayFields
                bind:invitation={pairingInvitation}
                bind:gatewayUrl
                bind:enrollmentToken
                bind:fingerprint={gatewayFingerprint}
                migrating={status?.needsPairing}
                disabled={busy}
              />
            {:else}
              <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
                Your data stays on this computer. No database installation or account is needed. Phones, linked
                computers and remote workers connect through Settings → Network access.
              </p>
            {/if}
            {#if message}<Alert tone="error">{message}</Alert>{/if}
            {#if status?.configuration && !unchanged}
              <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
                Saving restarts this computer’s services and stops its running agents. You’ll be asked to confirm.
              </p>
            {/if}
            <div class="flex flex-wrap items-center gap-3">
              <Button variant="primary" type="submit" loading={working}
                >{status?.configuration ? "Save and open Canopy" : "Open Canopy"}</Button
              >
              {#if busy}<p role="status" class="text-sm text-zinc-500 dark:text-zinc-400">Saving mode settings…</p>{/if}
            </div>
          </div>
        </form>
      {/if}
    </div>
  {/if}
</main>

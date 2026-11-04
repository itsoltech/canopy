<script lang="ts">
  import { onMount } from "svelte";
  import type { DesktopMode, DesktopStatus } from "@canopy/ui/desktop";
  import Button from "#lib/shared/ui/Button.svelte";
  import RemoteGatewayFields from "./RemoteGatewayFields.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import ModeChoice from "./ModeChoice.svelte";
  import WorkerStatus from "./WorkerStatus.svelte";
  import AppUpdates from "./AppUpdates.svelte";
  import QuitShortcutSettings from "./QuitShortcutSettings.svelte";
  import DesktopStartup from "./DesktopStartup.svelte";

  let { settings = false }: { settings?: boolean } = $props();

  let mode = $state<DesktopMode>("local");
  let status = $state<DesktopStatus>();
  let available = $state<boolean>();
  let busy = $state(false);
  const working = $derived(busy || status?.phase === "starting");

  const startup = $derived(
    available !== false && (!status || busy || (!settings && (status.mode !== null || status.phase !== "setup"))),
  );

  let message = $state("");
  let gatewayUrl = $state("");
  let pairingInvitation = $state("");
  let workerGatewayUrl = $state<string>();
  let enrollmentToken = $state("");
  let gatewayFingerprint = $state("");
  let revealed = $state(false);

  onMount(() => {
    revealed = true;
    const bridge = window.canopyDesktop;
    available = Boolean(bridge);

    if (!bridge) return;
    void bridge
      .status()
      .then((value) => {
        status = value;
        mode = value.mode ?? "local";

        if (value.mode === "remote") {
          gatewayUrl = value.gatewayUrl ?? "";
          workerGatewayUrl = value.workerGatewayUrl;
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
    busy = true;
    message = "";

    try {
      await window.canopyDesktop.configure(
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
<!-- On macOS the window has no title bar: the top of the screen moves it (routes/layout.css). -->
<div class="fixed inset-x-0 top-0 hidden h-12 macos:block" data-window-drag></div>
<main
  class="isolate flex min-h-dvh items-center bg-white pt-[max(3rem,var(--window-safe-top))] pb-12 text-zinc-950 dark:bg-black dark:text-white"
>
  {#if startup}
    <DesktopStartup {status} {message} retrying={busy} onretry={() => void submit()} />
  {:else}
    <div class="mx-auto grid w-full max-w-2xl gap-8 px-6 sm:px-10">
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
          <div class="t-panel-slide grid gap-5 [--panel-translate-y:12px]" data-open={revealed}>
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
            {#if message || status?.error}<Alert tone="error">{message || status?.error}</Alert>{/if}
            <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
              Install Claude Code, Codex or Grok on this computer to use that provider. Canopy does not install agent
              CLIs.
            </p>
            <div class="flex flex-wrap items-center gap-3">
              <Button variant="primary" type="submit" loading={working}
                >{status?.phase === "error"
                  ? "Try again"
                  : status?.mode
                    ? "Save and open Canopy"
                    : "Open Canopy"}</Button
              >
            </div>
          </div>
        </form>
        {#if status?.mode}<div class="grid gap-3 border-t border-zinc-950/5 pt-6 dark:border-white/10">
            <WorkerStatus {status} />
            <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
              Saving these settings restarts this computer’s services and stops its running agents.
            </p>
          </div>{/if}
        <AppUpdates />
        <QuitShortcutSettings />
      {/if}
    </div>
  {/if}
</main>

<style>
  :global(:root) {
    --panel-open-dur: 400ms;
    --panel-close-dur: 350ms;
    --panel-translate-y: 100px;
    --panel-blur: 2px;
    --panel-ease: cubic-bezier(0.22, 1, 0.36, 1);
  }
  .t-panel-slide {
    transform: translateY(var(--panel-translate-y));
    opacity: 0;
    filter: blur(var(--panel-blur));
    pointer-events: none;
    transition:
      transform var(--panel-close-dur) var(--panel-ease),
      opacity var(--panel-close-dur) var(--panel-ease),
      filter var(--panel-close-dur) var(--panel-ease);
    will-change: transform, opacity, filter;
  }
  .t-panel-slide[data-open="true"] {
    transform: translateY(0);
    opacity: 1;
    filter: blur(0);
    pointer-events: auto;
    transition:
      transform var(--panel-open-dur) var(--panel-ease),
      opacity var(--panel-open-dur) var(--panel-ease),
      filter var(--panel-open-dur) var(--panel-ease);
    will-change: transform, opacity, filter;
  }
  @media (prefers-reduced-motion: reduce) {
    .t-panel-slide {
      transition: none !important;
    }
  }
</style>

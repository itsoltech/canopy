<script lang="ts">
  import { onMount } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { timestampDate } from "@bufbuild/protobuf/wkt";
  import { ui } from "@open-agents/contracts";
  import QRCode from "qrcode";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";

  const overview = useOverview();
  let setup = $state.raw(create(ui.GetMobileDevicesResponseSchema));
  let invitation = $state<ui.CreateMobilePairingResponse>();
  let open = $state(false);
  let qr = $state("");
  let busy = $state(false);
  let loaded = $state(false);
  let error = $state("");
  let copied = $state(false);
  let now = $state(Date.now());
  const activePairing = $derived(setup.pairings.find((p) => p.id === invitation?.pairing?.id) ?? invitation?.pairing);
  const seconds = $derived(Math.max(0, Math.ceil(((activePairing?.expiresAt ? timestampDate(activePairing.expiresAt).getTime() : 0) - now) / 1000)));
  const usable = $derived(seconds > 0 && !activePairing?.usedAt && !activePairing?.revokedAt);
  const pending = $derived(setup.pairings.filter((p) => !p.usedAt && !p.revokedAt && p.expiresAt && timestampDate(p.expiresAt).getTime() > now));
  async function reload() {
    try { setup = decode(ui.GetMobileDevicesResponseSchema, await requestJson("GET", "/api/mobile-devices")); loaded = true; }
    catch (e) { error = e instanceof Error ? e.message : "Could not load mobile devices"; }
  }
  onMount(() => {
    void reload();
    const unsubscribe = overview.subscribe((u) => { if (u.change.case === "mobileDevice" || u.change.case === "mobilePairing") void reload(); });
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    // Also recover after a missed overview event or a disconnected browser.
    const refresh = setInterval(() => void reload(), 15_000);
    return () => { unsubscribe(); clearInterval(timer); clearInterval(refresh); };
  });
  $effect(() => { if (!open) { invitation = undefined; qr = ""; copied = false; } });
  async function pair() {
    busy = true; error = "";
    try {
      invitation = decode(ui.CreateMobilePairingResponseSchema, await requestJson("POST", "/api/mobile-devices", {}));
      // Data only: never put the one-time secret in a URL, analytics or an external QR service.
      qr = await QRCode.toDataURL(JSON.stringify({ type: "canopy-pair", version: 1, gatewayUrl: invitation.gatewayUrl, code: invitation.code }), { width: 260, margin: 2, errorCorrectionLevel: "M" });
      open = true;
      await reload();
    } catch (e) { error = e instanceof Error ? e.message : "Could not create pairing code"; }
    finally { busy = false; }
  }
  async function revoke(id: string, kind: "device" | "pairing") {
    busy = true; error = "";
    try { await requestJson("DELETE", `/api/mobile-devices/${id}?kind=${kind}`, {}); await reload(); }
    catch (e) { error = e instanceof Error ? e.message : "Could not revoke device"; }
    finally { busy = false; }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(invitation?.code ?? ""); copied = true; }
    catch { error = "Select and copy the code manually."; }
  }
</script>

<svelte:head><title>Mobile devices · Settings · Canopy</title></svelte:head>
<div class="flex flex-wrap items-start justify-between gap-4 px-1">
  <div class="min-w-0">
    <h1 class="text-base/7 font-semibold text-zinc-950 dark:text-white">Mobile devices</h1>
    <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Your Canopy, with you. Connect a phone over your private Tailscale network.</p>
  </div>
  <Button variant="primary" disabled={!loaded || !setup.gatewayUrl || busy} loading={busy} onclick={() => void pair()}>Pair a phone</Button>
</div>
{#if error}<Alert tone="error">{error}<Button size="sm" onclick={() => { error = ""; void reload(); }}>Retry</Button></Alert>{/if}
{#if loaded && !setup.gatewayUrl}<Alert tone="warning">Set OA_MOBILE_PORT and OA_MOBILE_GATEWAY_URL on the gateway, then configure private Tailscale Serve. See docs/mobile.md.</Alert>{/if}
<SettingsGroup title="Paired devices">
  {#each setup.devices as device (device.id)}
    <SettingsRow title={device.name} description={`${device.platform} · ${device.revokedAt ? "Revoked" : device.lastSeenAt ? `Last seen ${timestampDate(device.lastSeenAt).toLocaleString()}` : "Not connected yet"}`}>
      {#snippet control()}{#if !device.revokedAt}<Button size="sm" variant="ghost" disabled={busy} onclick={() => void revoke(device.id, "device")}>Revoke access</Button>{/if}{/snippet}
    </SettingsRow>
  {:else}<SettingsRow title={loaded ? "No phones paired yet" : "Loading devices…"} description="Pair once. Access stays on your phone until you revoke it here or unpair in the app." />{/each}
</SettingsGroup>
{#if pending.length}
  <SettingsGroup title="Pending pairing codes">
    {#each pending as p (p.id)}
      <SettingsRow title="Waiting for a phone" description={`Expires ${p.expiresAt ? timestampDate(p.expiresAt).toLocaleTimeString() : "soon"}`}>
        {#snippet control()}<Button size="sm" variant="ghost" disabled={busy} onclick={() => void revoke(p.id, "pairing")}>Revoke code</Button>{/snippet}
      </SettingsRow>
    {/each}
  </SettingsGroup>
{/if}
<Dialog bind:open title="Pair a phone" description="Open Canopy on your phone and scan this QR code.">
  <div class="grid justify-items-center gap-5 text-center">
    {#if activePairing?.usedAt}<Alert tone="info">Phone paired. You can close this window.</Alert>
    {:else if !usable}<Alert tone="warning">This code expired or was revoked. Close this window and create a new code.</Alert>
    {:else}
      <img src={qr} alt="One-time Canopy pairing QR code" width="260" height="260" class="rounded-xl bg-white" />
      <div class="grid gap-2">
        <p class="text-base/6 text-zinc-500 dark:text-zinc-400">Or enter this code in the app</p>
        <p class="select-all font-mono text-xl tracking-wide">{invitation?.code}</p>
        <Button size="sm" onclick={() => void copy()}>{copied ? "Copied" : "Copy code"}</Button>
      </div>
      <p class="max-w-full break-all text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">{invitation?.gatewayUrl}</p>
      <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">One use · expires in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</p>
    {/if}
  </div>
</Dialog>

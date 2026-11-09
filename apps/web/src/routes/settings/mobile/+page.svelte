<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import { onMount } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { toJsonString } from "@bufbuild/protobuf";
  import { timestampDate } from "@bufbuild/protobuf/wkt";
  import { formatDateTime, formatTime } from "#lib/shared/format.ts";
  import { ui } from "@canopy/contracts";
  import QRCode from "qrcode";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import DevicePairingDialog from "#lib/features/network/DevicePairingDialog.svelte";
  import NetworkAccessSummary from "#lib/features/network/NetworkAccessSummary.svelte";
  import { useNetworkAccess } from "#lib/features/network/network-access.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import { useConnectionRequest } from "#lib/features/network/connection-request.svelte.ts";
  import ConnectionRequestError from "#lib/features/network/ConnectionRequestError.svelte";

  const overview = useOverview();
  const network = useNetworkAccess();

  const request = useConnectionRequest(create(ui.GetMobileDevicesResponseSchema), async () =>
    decode(ui.GetMobileDevicesResponseSchema, await requestJson("GET", "/api/mobile-devices")),
  );

  const setup = $derived(request.data);
  let invitation = $state<ui.CreateMobilePairingResponse>();
  let open = $state(false);
  let qr = $state("");
  let busy = $state(false);
  let error = $state("");
  let copied = $state(false);
  let now = $state(Date.now());
  const activePairing = $derived(setup.pairings.find((p) => p.id === invitation?.pairing?.id) ?? invitation?.pairing);

  const seconds = $derived(
    Math.max(
      0,
      Math.ceil(((activePairing?.expiresAt ? timestampDate(activePairing.expiresAt).getTime() : 0) - now) / 1000),
    ),
  );

  const usable = $derived(seconds > 0 && !activePairing?.usedAt && !activePairing?.revokedAt);

  const pending = $derived(
    setup.pairings.filter(
      (p) => !p.usedAt && !p.revokedAt && p.expiresAt && timestampDate(p.expiresAt).getTime() > now,
    ),
  );

  const reload = request.reload;

  onMount(() => {
    void reload();

    const unsubscribe = overview.subscribe((u) => {
      if (u.change.case === "mobileDevice" || u.change.case === "mobilePairing") void reload();
    });

    const timer = setInterval(() => {
      now = Date.now();
    }, 1000);

    // Also recover after a missed overview event or a disconnected browser.
    const refresh = setInterval(() => void reload(), 15_000);

    return () => {
      unsubscribe();
      clearInterval(timer);
      clearInterval(refresh);
    };
  });

  $effect(() => {
    if (!open) {
      if (invitation?.pairing && !activePairing?.usedAt && !activePairing?.revokedAt)
        void requestJson("DELETE", `/api/mobile-devices/${invitation.pairing.id}?kind=pairing`, {}).catch(() => {});
      invitation = undefined;
      qr = "";
      copied = false;
    }
  });

  async function pair(kind: "mobile" | "desktop" = "mobile") {
    busy = true;
    error = "";

    try {
      if (network.status.state !== "on") await network.update("set_enabled", { enabled: true });

      if (network.status.state !== "on") throw new Error(network.status.error || "Network access is unavailable.");

      const nextInvitation = decode(
        ui.CreateMobilePairingResponseSchema,
        await requestJson("POST", `/api/mobile-devices?kind=${kind}`, {}),
      );

      // Data only: never put the one-time secret in a URL, analytics or an external QR service.
      const nextQr = await QRCode.toDataURL(
        JSON.stringify({
          type: "canopy-pair",
          version: 2,
          addresses: nextInvitation.routes?.addresses,
          fingerprint: nextInvitation.routes?.fingerprint,
          code: nextInvitation.code,
        }),
        { width: 260, margin: 2, errorCorrectionLevel: "M" },
      );

      invitation = nextInvitation;
      qr = nextQr;
      open = true;
      await reload();
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not create pairing code";
    } finally {
      busy = false;
    }
  }

  async function revoke(id: string, kind: "device" | "pairing") {
    busy = true;
    error = "";

    try {
      await requestJson("DELETE", `/api/mobile-devices/${id}?kind=${kind}`, {});
      await reload();
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not revoke device";
    } finally {
      busy = false;
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(
        invitation?.pairing?.clientKind === "desktop"
          ? toJsonString(ui.CreateMobilePairingResponseSchema, invitation)
          : (invitation?.code ?? ""),
      );
      copied = true;
    } catch {
      error = "Select and copy the code manually.";
    }
  }
</script>

<svelte:head><title>Devices · Settings · {applicationName}</title></svelte:head>
<div class="flex flex-wrap items-start justify-between gap-4 px-1">
  <div class="min-w-0">
    <h1 class="text-base/7 font-semibold text-zinc-950 dark:text-white">Devices</h1>
    <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      Your Canopy, with you. Pair once and connect on any Wi-Fi or VPN you share with this computer.
    </p>
  </div>
  <div class="flex flex-wrap gap-3">
    <Button
      disabled={!request.loaded || !network.loaded || !!network.error || !!request.error || busy}
      onclick={() => void pair("desktop")}>Pair a desktop app</Button
    >
    <Button
      variant="primary"
      disabled={!request.loaded || !network.loaded || !!network.error || !!request.error || busy}
      loading={busy}
      onclick={() => void pair()}
      >{network.loaded && !network.error && network.status.state === "off"
        ? "Turn on network access and pair a phone"
        : "Pair a phone"}</Button
    >
  </div>
</div>
{#if request.error}<ConnectionRequestError
    title="Could not load paired devices"
    error={request.error}
    loaded={request.loaded}
    loading={request.loading}
    onretry={() => void reload()}
  />{/if}
{#if error}<Alert tone="error"
    >{error}<Button
      size="sm"
      onclick={() => {
        error = "";
        void reload();
      }}>Retry</Button
    ></Alert
  >{/if}
<NetworkAccessSummary
  {network}
  busy={busy || network.busy}
  onenable={() =>
    void network.update("set_enabled", { enabled: true }).catch((e) => {
      error = e instanceof Error ? e.message : "Could not enable network access";
    })}
/>
<SettingsGroup title="Paired devices">
  {#each setup.devices as device (device.id)}
    <SettingsRow
      title={device.name}
      description={`${device.clientKind === "desktop" ? "Desktop app · " : ""}${device.platform} · ${device.pairingVersion < 2 ? "Pair again to use this computer's secure network connection." : device.revokedAt ? "Revoked" : device.lastSeenAt ? `Last seen ${formatDateTime(device.lastSeenAt)}` : "Not connected yet"}`}
    >
      {#snippet control()}{#if device.pairingVersion < 2}<Button
            size="sm"
            disabled={busy}
            onclick={() => void pair(device.clientKind === "desktop" ? "desktop" : "mobile")}>Pair again</Button
          >
        {:else if !device.revokedAt}<Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onclick={() => void revoke(device.id, "device")}>Revoke access</Button
          >{/if}{/snippet}
    </SettingsRow>
  {:else}<SettingsRow
      title={request.loaded
        ? "No devices paired yet"
        : request.error
          ? "Paired devices unavailable"
          : "Loading devices…"}
      description={request.loaded
        ? "Pair a phone or desktop app. Revoke its access here at any time."
        : request.error
          ? "Retry the paired devices request above."
          : undefined}
    />{/each}
</SettingsGroup>
{#if pending.length}
  <SettingsGroup title="Pending pairing codes">
    {#each pending as p (p.id)}
      <SettingsRow
        title={p.clientKind === "desktop" ? "Waiting for a desktop app" : "Waiting for a phone"}
        description={`Expires ${formatTime(p.expiresAt) || "soon"}`}
      >
        {#snippet control()}<Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onclick={() => void revoke(p.id, "pairing")}>Revoke code</Button
          >{/snippet}
      </SettingsRow>
    {/each}
  </SettingsGroup>
{/if}
<DevicePairingDialog
  bind:open
  {invitation}
  {qr}
  {usable}
  {seconds}
  {copied}
  paired={!!activePairing?.usedAt}
  oncopy={() => void copy()}
/>

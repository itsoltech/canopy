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
  import SettingsTopics from "#lib/features/settings/SettingsTopics.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import DevicePairingDialog from "#lib/features/network/DevicePairingDialog.svelte";
  import NetworkAccessSummary from "#lib/features/network/NetworkAccessSummary.svelte";
  import { useNetworkAccess } from "#lib/features/network/network-access.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import { useConnectionRequest } from "#lib/features/network/connection-request.svelte.ts";
  import ConnectionRequestError from "#lib/features/network/ConnectionRequestError.svelte";

  let topics: ReturnType<typeof SettingsTopics> | undefined;
  const overview = useOverview();
  const network = useNetworkAccess();

  const request = useConnectionRequest(create(ui.GetMobileDevicesResponseSchema), async () =>
    decode(ui.GetMobileDevicesResponseSchema, await requestJson("GET", "/api/mobile-devices")),
  );

  const setup = $derived(request.data);
  const activeDevices = $derived(setup.devices.filter((device) => !device.revokedAt));
  const revokedDevices = $derived(setup.devices.filter((device) => Boolean(device.revokedAt)));

  const desktopAccessLabels = $derived.by(() => {
    const labels = new Map<string, string>();
    const counts = new Map<string, number>();

    // Include revoked grants so the labels stay stable when a grant is revoked.
    for (const device of setup.devices) {
      if (device.clientKind !== "desktop") continue;
      const pairedAt = formatDateTime(device.createdAt);
      const label = `Desktop app · ${device.platform}${pairedAt ? ` · Paired ${pairedAt}` : ""}`;
      labels.set(device.id, label);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }

    for (const [id, label] of labels) {
      if ((counts.get(label) ?? 0) > 1) labels.set(id, `${label} · Access ID ${id}`);
    }

    return labels;
  });

  let invitation = $state<ui.CreateMobilePairingResponse>();
  let open = $state(false);
  let qr = $state("");
  let busy = $state(false);
  let error = $state("");
  let copyState = $state<"idle" | "copied" | "manual">("idle");
  let now = $state(Date.now());
  const activePairing = $derived(setup.pairings.find((p) => p.id === invitation?.pairing?.id) ?? invitation?.pairing);

  const seconds = $derived(
    Math.max(
      0,
      Math.ceil(((activePairing?.expiresAt ? timestampDate(activePairing.expiresAt).getTime() : 0) - now) / 1000),
    ),
  );

  const usable = $derived(seconds > 0 && !activePairing?.usedAt && !activePairing?.revokedAt);

  const pairingText = $derived(
    open && usable && invitation
      ? invitation.pairing?.clientKind === "desktop"
        ? toJsonString(ui.CreateMobilePairingResponseSchema, invitation)
        : invitation.code
      : "",
  );

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

    // Pairing and revocation arrive as events; last-seen times have none, so one visible check a minute.
    const refresh = setInterval(() => {
      if (!document.hidden) void reload();
    }, 60_000);

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
      copyState = "idle";
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
    const pairing = invitation;

    if (!pairing || !pairingText) return;

    let result: "copied" | "manual";

    try {
      await navigator.clipboard.writeText(pairingText);
      result = "copied";
    } catch {
      result = "manual";
    }

    if (open && usable && invitation === pairing) copyState = result;
  }
</script>

<svelte:head><title>Devices · Settings · {applicationName}</title></svelte:head>
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

<SettingsTopics
  bind:this={topics}
  label="Device settings"
  topics={[
    { id: "pairing", label: "Pairing", content: pairing },
    { id: "device-access", label: "Device access", content: devices },
  ]}
/>

{#snippet pairing()}
  <div class="grid gap-3 px-1">
    <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      Pair once and connect on any Wi-Fi or VPN you share with this computer.
      {#if network.loaded && !network.error && network.status.state === "off"}
        Pairing turns on network access.
      {/if}
    </p>
    <div class="flex flex-wrap gap-3">
      <Button
        disabled={!request.loaded || !network.loaded || !!network.error || !!request.error || busy}
        onclick={() => void pair("desktop")}>Pair a desktop app</Button
      >
      <Button
        variant="primary"
        disabled={!request.loaded || !network.loaded || !!network.error || !!request.error || busy}
        loading={busy}
        onclick={() => void pair()}>Pair a phone</Button
      >
    </div>
  </div>
  <NetworkAccessSummary
    {network}
    busy={busy || network.busy}
    onenable={() =>
      void network.update("set_enabled", { enabled: true }).catch((e) => {
        error = e instanceof Error ? e.message : "Could not enable network access";
      })}
  />
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
{/snippet}

{#snippet devices()}
  <SettingsGroup
    title="Paired devices"
    description={activeDevices.filter((device) => device.clientKind === "desktop").length > 1
      ? "Each desktop pairing grants separate access."
      : undefined}
  >
    {#each activeDevices as device (device.id)}
      <SettingsRow title={device.name}>
        {@render deviceDetails(
          device,
          device.pairingVersion < 2
            ? "Pair again to use this computer's secure network connection."
            : device.lastSeenAt
              ? `Last seen ${formatDateTime(device.lastSeenAt)}`
              : "Not connected yet",
        )}
        {#snippet control()}{#if device.pairingVersion < 2}<Button
              size="sm"
              disabled={busy}
              onclick={() => void pair(device.clientKind === "desktop" ? "desktop" : "mobile")}>Pair again</Button
            >
          {:else}<Button
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-label={`Revoke access for ${device.name}`}
              aria-describedby={`device-access-${device.id}`}
              onclick={() => void revoke(device.id, "device")}>Revoke access</Button
            >{/if}{/snippet}
      </SettingsRow>
    {:else}<SettingsRow
        title={request.loaded && revokedDevices.length
          ? "No active devices"
          : request.loaded
            ? "No devices paired yet"
            : request.error
              ? "Paired devices unavailable"
              : "Loading devices…"}
      >
        {#snippet control()}
          {#if request.loaded}
            <Button size="sm" onclick={() => topics?.selectTopic("pairing")}>Pair a device</Button>
          {/if}
        {/snippet}
      </SettingsRow>{/each}
    {#if revokedDevices.length}
      <Disclosure summaryClass="px-4 py-3.5 text-base/6 sm:text-sm/6">
        {#snippet summary()}
          <span class="flex min-w-0 items-center gap-2">
            <span>Revoked devices</span>
            <Badge compact>{revokedDevices.length}</Badge>
          </span>
        {/snippet}
        <div class="divide-y divide-zinc-950/5 dark:divide-white/8">
          {#each revokedDevices as device (device.id)}
            <SettingsRow title={device.name}>{@render deviceDetails(device)}</SettingsRow>
          {/each}
        </div>
      </Disclosure>
    {/if}
  </SettingsGroup>
{/snippet}

{#snippet deviceDetails(device: ui.MobileDevice, status?: string)}
  <p id={`device-access-${device.id}`} class="text-sm/5 text-pretty wrap-anywhere text-zinc-500 dark:text-zinc-400">
    {desktopAccessLabels.get(device.id) ?? device.platform}{status ? ` · ${status}` : ""}
  </p>
{/snippet}

<DevicePairingDialog
  bind:open
  {invitation}
  {qr}
  {usable}
  {seconds}
  copied={copyState === "copied"}
  manualCopyText={copyState === "manual" ? pairingText : ""}
  paired={!!activePairing?.usedAt}
  oncopy={() => void copy()}
/>

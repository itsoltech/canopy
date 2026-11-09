<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import { onMount } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import { requestJson } from "#lib/shared/http.ts";
  import type { JsonObject } from "#lib/shared/json.ts";
  import { decode } from "#lib/shared/wire.ts";
  import ComputerDetails from "#lib/features/settings/ComputerDetails.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import NetworkAccessSummary from "#lib/features/network/NetworkAccessSummary.svelte";
  import { useNetworkAccess } from "#lib/features/network/network-access.svelte.ts";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import AddRouteDialog from "#lib/features/computers/AddRouteDialog.svelte";
  import LanDiscoveryRow from "#lib/features/computers/LanDiscoveryRow.svelte";
  import ShareOnwardDialog from "#lib/features/computers/ShareOnwardDialog.svelte";
  import MoveDialog from "#lib/features/computers/MoveDialog.svelte";
  import { MOVE_ITEMS, RELAY } from "@canopy/domain/computers";
  import { useConnectionRequest } from "#lib/features/network/connection-request.svelte.ts";
  import ConnectionRequestError from "#lib/features/network/ConnectionRequestError.svelte";
  import ConfigSharing from "#lib/features/computers/ConfigSharing.svelte";
  import ConfigNotice from "#lib/features/computers/ConfigNotice.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import PairingChoice from "#lib/features/computers/PairingChoice.svelte";
  import PairingInvitation from "#lib/features/computers/PairingInvitation.svelte";

  const network = useNetworkAccess();
  const overview = useOverview();

  const request = useConnectionRequest(create(ui.ComputersSnapshotSchema), async () =>
    decode(ui.ComputersSnapshotSchema, await requestJson("GET", "/api/computers")),
  );

  const setup = $derived(request.data);
  const loaded = $derived(request.loaded);
  let busy = $state(false);
  let error = $state("");
  let open = $state(false);
  let mode = $state<"choose" | "invite" | "enter" | "linked">("choose");
  let invitation = $state<ui.ComputerPairing>();
  let address = $state("");
  let code = $state("");
  let rename = $state<ui.LinkedComputer>();
  let renameOpen = $state(false);
  let name = $state("");
  let remove = $state<ui.LinkedComputer>();
  let removeOpen = $state(false);
  let copied = $state("");
  let shareConfig = $state(true);
  const groupNames = $derived(setup.configGroup.filter((c) => c.nodeId !== setup.self?.nodeId).map((c) => c.name));

  const groupDescription = $derived(
    groupNames.length
      ? `Shares configuration with ${new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(groupNames)}`
      : "Configuration stays on this computer.",
  );

  let routeFor = $state<ui.LinkedComputer>();
  let routeOpen = $state(false);
  let shareFor = $state("");
  let shareOpen = $state(false);
  const shareComputer = $derived(setup.peers.find((p) => p.nodeId === shareFor));
  let moveFor = $state("");
  let moveOpen = $state(false);
  let now = $state(Date.now());
  const remaining = $derived(Math.max(0, Math.ceil((Number(invitation?.expiresAtMs ?? 0n) - now) / 1000)));

  async function run(action: () => Promise<void>) {
    busy = true;
    error = "";

    try {
      await action();
    } catch (e) {
      error = e instanceof Error ? e.message : "Computer link operation failed";
    } finally {
      busy = false;
    }
  }

  async function reload() {
    await request.reload();

    if (invitation && setup.peers.some((p) => p.linkedAtMs >= invitation!.expiresAtMs - 600_000n)) {
      invitation = undefined;
      mode = "linked";
    }
  }

  async function manage(action: string, extra: JsonObject = {}) {
    request.set(decode(ui.ComputersSnapshotSchema, await requestJson("PUT", "/api/computers", { action, ...extra })));
  }

  // Presence, names, links and unlinks arrive as overview events; an open invitation is checked every 2 s until
  // the other computer accepts it; otherwise one visible check a minute covers routes and notices.
  onMount(() =>
    overview.subscribe((update) => {
      if (["computer", "computerRemoved", "sharedConfig"].includes(update.change.case ?? "") && !busy) void reload();
    }),
  );

  onMount(() => {
    void reload();
    let last = Date.now();

    const refresh = setInterval(() => {
      if (busy || document.hidden) return;
      const waiting = !!invitation && remaining > 0;

      if (!waiting && Date.now() - last < 60_000) return;
      last = Date.now();
      void reload();
    }, 2000);

    const clock = setInterval(() => {
      now = Date.now();
    }, 1000);

    return () => {
      clearInterval(refresh);
      clearInterval(clock);
    };
  });

  /** One click from the pairing dialog: network access on, then the code. */
  async function enableAndInvite() {
    await run(async () => {
      await network.update("set_enabled", { enabled: true });

      if (network.status.state === "error") throw new Error(network.status.error);
      await reload();
    });

    if (network.status.state === "on") await invite();
  }

  async function invite() {
    await run(async () => {
      invitation = decode(
        ui.ComputerPairingSchema,
        await requestJson("POST", "/api/computers/pairing", { shareConfig }),
      );
      mode = "invite";
    });
  }

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      copied = label;
    } catch {
      error = "Select the text and copy it manually.";
    }
  }

  function edit(computer: ui.LinkedComputer) {
    error = "";
    name = computer.displayName || computer.name;
    rename = computer;
    renameOpen = true;
  }

  // Closing forgets the secret in browser memory; a pending code is revoked.
  $effect(() => {
    if (!open) {
      if (invitation) void manage("revoke_pairing").catch(() => {});
      invitation = undefined;
      mode = "choose";
      code = "";
      copied = "";
    }
  });
</script>

<svelte:head><title>Linked computers · Settings · {applicationName}</title></svelte:head>
<div class="flex flex-col items-start justify-between gap-4 px-1 sm:flex-row">
  <div class="min-w-0 flex-1">
    <h1 class="text-base font-semibold text-balance text-zinc-950 dark:text-white">Linked computers</h1>
    <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      Connect your own computers. Each keeps its own gateway and data.
    </p>
  </div>
  <Button
    variant="primary"
    disabled={!loaded || !!request.error || busy}
    onclick={() => {
      error = "";
      open = true;
    }}>Link a computer</Button
  >
</div>
{#if request.error}<ConnectionRequestError
    title="Could not load linked computers"
    error={request.error}
    {loaded}
    loading={request.loading}
    onretry={() => void reload()}
  />{/if}
{#if error && !open && !renameOpen && !removeOpen && !routeOpen && !shareOpen}<Alert tone="error"
    >{error}<Button size="sm" onclick={() => void run(reload)}>Retry</Button></Alert
  >{/if}
<SettingsGroup title="This computer">
  {#if setup.self}<ComputerDetails computer={setup.self} self {busy} onrename={() => setup.self && edit(setup.self)} />
  {:else}<SettingsRow
      title={request.error || loaded ? "Computer identity unavailable" : "Loading computer identity…"}
    />{/if}
  {#if setup.self}<LanDiscoveryRow
      {setup}
      disabled={busy || !!request.error}
      onchange={(enabled) => void run(() => manage("lan_discovery", { enabled }))}
    />{/if}
</SettingsGroup>
<p role="status" class="px-1 text-base/6 text-pretty break-words text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
  {groupDescription}
</p>
<NetworkAccessSummary
  {network}
  busy={network.busy || busy}
  onenable={() => void run(async () => void (await network.update("set_enabled", { enabled: true })))}
/>
<SettingsGroup
  title="Linked computers"
  description="Pairing grants full access between your computers. Only link computers you own."
>
  {#each setup.peers as computer (computer.nodeId)}
    <ComputerDetails
      {computer}
      {busy}
      {now}
      onrename={() => edit(computer)}
      onunlink={() => {
        error = "";
        remove = computer;
        removeOpen = true;
      }}
      onshare={!computer.viaNodeId && (computer.capabilities.includes(RELAY) || computer.shareOnwardNodeIds.length)
        ? () => {
            error = "";
            shareFor = computer.nodeId;
            shareOpen = true;
          }
        : undefined}
      onmove={!computer.viaNodeId && computer.capabilities.includes(MOVE_ITEMS)
        ? () => {
            moveFor = computer.nodeId;
            moveOpen = true;
          }
        : undefined}
      onaddroute={() => {
        error = "";
        routeFor = computer;
        routeOpen = true;
      }}
      onremoveroute={(address) => void run(() => manage("remove_route", { nodeId: computer.nodeId, address }))}
    />
    {#if !computer.viaNodeId}<ConfigSharing
        {computer}
        {busy}
        alternative={computer.configAlternativeName}
        onchange={(enabled) => run(() => manage("share_config", { nodeId: computer.nodeId, enabled }))}
      />{/if}
  {:else}<SettingsRow
      title={loaded
        ? "No computers linked yet"
        : request.error
          ? "Linked computers unavailable"
          : "Loading linked computers…"}
      description={loaded
        ? "Generate a code here, or enter a code from your other computer."
        : request.error
          ? "Retry the linked computers request above."
          : undefined}
    />{/each}
</SettingsGroup>
{#if setup.configNotices.length}<SettingsGroup title="Changed on two computers">
    {#each setup.configNotices as notice (notice.id)}<ConfigNotice
        {notice}
        {busy}
        onaction={(id, action) =>
          void run(async () => {
            request.set(
              decode(ui.ComputersSnapshotSchema, await requestJson("PUT", "/api/computers/notices", { id, action })),
            );
          })}
      />{/each}
  </SettingsGroup>{/if}
<Dialog
  bind:open
  title="Link a computer"
  description="Both computers belong to you and will have full access to each other."
>
  <div class="grid min-w-0 gap-5">
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    {#if mode === "choose" || mode === "enter"}
      <PairingChoice
        {network}
        {busy}
        choosing={mode === "choose"}
        bind:shareConfig
        onenable={() => void enableAndInvite()}
        oninvite={() => void invite()}
        onenter={() => {
          mode = "enter";
          error = "";
        }}
      />
    {/if}
    {#if mode === "invite" && invitation}
      <PairingInvitation
        {invitation}
        {remaining}
        {copied}
        {busy}
        oncopy={(value, label) => void copy(value, label)}
        oninvite={() => void invite()}
        onrevoke={() =>
          void run(async () => {
            await manage("revoke_pairing");
            invitation = undefined;
            mode = "choose";
          })}
      />
    {:else if mode === "enter"}
      <form
        class="grid gap-5"
        onsubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            request.set(
              decode(
                ui.ComputersSnapshotSchema,
                await requestJson("POST", "/api/computers", { address, code, shareConfig }, 25_000),
              ),
            );
            open = false;
          });
        }}
      >
        <Field label="Computer address"
          ><Input bind:value={address} placeholder="https://computer:port" required autocomplete="off" /></Field
        >
        <Field label="Pairing code"
          ><Input
            bind:value={code}
            placeholder="Paste the complete code"
            required
            autocomplete="off"
            spellcheck={false}
          /></Field
        >
        <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          The code verifies the other computer’s certificate before pairing. After linking, you can compare both
          fingerprints in Settings.
        </p>
        <Button type="submit" variant="primary" disabled={busy} loading={busy}>Link computers</Button>
      </form>
    {:else if mode === "linked"}
      <Alert tone="info"
        >Computer linked. Compare this computer’s fingerprint with its entry on the other computer, and vice versa.</Alert
      >
      <Button
        variant="primary"
        onclick={() => {
          open = false;
        }}>Done</Button
      >
    {/if}
  </div>
</Dialog>
<Dialog
  bind:open={renameOpen}
  title="Rename computer"
  description="A linked computer’s display name is local to this computer."
>
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  <form
    class="grid gap-5"
    onsubmit={(event) => {
      event.preventDefault();
      void run(async () => {
        await manage("rename", { nodeId: rename!.nodeId, name });
        renameOpen = false;
      });
    }}
  >
    <Field label="Computer name"><Input bind:value={name} required maxlength={100} /></Field>
    <Button type="submit" variant="primary" disabled={busy} loading={busy}>Save name</Button>
  </form>
</Dialog>
<Dialog
  bind:open={removeOpen}
  title="Unlink computer"
  description="This removes mutual access and the pinned certificate. An offline computer learns about unlinking when it reconnects."
>
  <div class="grid gap-4">
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <p class="text-base/6 sm:text-sm/6">Unlink {remove?.displayName || remove?.name}?</p>
    <Button
      variant="primary"
      disabled={busy}
      loading={busy}
      onclick={() =>
        void run(async () => {
          await manage("unlink", { nodeId: remove!.nodeId });
          removeOpen = false;
        })}>Unlink computer</Button
    >
  </div>
</Dialog>
<AddRouteDialog
  bind:open={routeOpen}
  computer={routeFor}
  {busy}
  {error}
  onsubmit={(address) =>
    void run(async () => {
      await manage("add_route", { nodeId: routeFor!.nodeId, address });
      routeOpen = false;
    })}
/>
<ShareOnwardDialog
  bind:open={shareOpen}
  computer={shareComputer}
  peers={setup.peers}
  {busy}
  {error}
  onchange={(shareOnwardNodeIds) => void run(() => manage("share_onward", { nodeId: shareFor, shareOnwardNodeIds }))}
/>
<MoveDialog bind:open={moveOpen} everything nodeId={moveFor} />

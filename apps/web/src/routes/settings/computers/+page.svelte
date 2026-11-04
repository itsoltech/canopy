<script lang="ts">
  import { onMount } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import ComputerDetails from "#lib/features/settings/ComputerDetails.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import SharedConfigOverview from "#lib/features/computers/SharedConfigOverview.svelte";

  let setup = $state.raw(create(ui.ComputersSnapshotSchema));
  let loaded = $state(false);
  let busy = $state(false);
  let error = $state("");
  let refreshError = $state("");
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
  let now = $state(Date.now());
  const remaining = $derived(Math.max(0, Math.ceil((Number(invitation?.expiresAtMs ?? 0n) - now) / 1000)));
  async function run(action: () => Promise<void>) {
    busy = true; error = "";
    try { await action(); } catch (e) { error = e instanceof Error ? e.message : "Computer link operation failed"; }
    finally { busy = false; }
  }
  async function reload() {
    setup = decode(ui.ComputersSnapshotSchema, await requestJson("GET", "/api/computers")); loaded = true;
    refreshError = "";
    if (invitation && setup.peers.some((p) => p.linkedAtMs >= invitation!.expiresAtMs - 600_000n)) {
      invitation = undefined; mode = "linked";
    }
  }
  async function manage(action: string, extra: Record<string, unknown> = {}) {
    setup = decode(ui.ComputersSnapshotSchema, await requestJson("PUT", "/api/computers", { action, ...extra }));
  }
  onMount(() => {
    void reload().catch(() => { refreshError = "Could not load computer status. Try again."; });
    const refresh = setInterval(() => { if (!busy && !document.hidden) void reload().catch(() => { refreshError = "Could not refresh computer status. Try again."; }); }, 3000);
    const clock = setInterval(() => { now = Date.now(); }, 1000);
    return () => { clearInterval(refresh); clearInterval(clock); };
  });
  async function invite() {
    await run(async () => { invitation = decode(ui.ComputerPairingSchema, await requestJson("POST", "/api/computers/pairing", {})); mode = "invite"; });
  }
  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); copied = label; }
    catch { error = "Select the text and copy it manually."; }
  }
  function edit(computer: ui.LinkedComputer) { error = ""; name = computer.displayName || computer.name; rename = computer; renameOpen = true; }
  // Closing forgets the secret in browser memory; a pending code is revoked.
  $effect(() => {
    if (!open) {
      if (invitation) void manage("revoke_pairing").catch(() => {});
      invitation = undefined; mode = "choose"; code = ""; copied = "";
    }
  });
</script>

<svelte:head><title>Linked computers · Settings · Canopy</title></svelte:head>
<div class="flex flex-col items-start justify-between gap-4 px-1 sm:flex-row">
  <div class="min-w-0 flex-1">
    <h1 class="text-balance text-base font-semibold text-zinc-950 dark:text-white">Linked computers</h1>
    <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Connect your own computers. Each keeps its own gateway and data.</p>
  </div>
  <Button variant="primary" disabled={!loaded || busy} onclick={() => { error = ""; open = true; }}>Link a computer</Button>
</div>
{#if (error || refreshError) && !open && !renameOpen && !removeOpen}<Alert tone="error">{error || refreshError}<Button size="sm" onclick={() => void run(reload)}>Retry</Button></Alert>{/if}
<SettingsGroup title="This computer">
  {#if setup.self}<ComputerDetails computer={setup.self} self {busy} onrename={() => setup.self && edit(setup.self)} />
  {:else}<SettingsRow title="Loading computer identity…" />{/if}
  <SettingsRow title="Allow linked computers to connect" description="Opens a dedicated encrypted listener. Access requires pairing; your web interface and database stay private.">
    {#snippet control()}<Switch name="link-listener" label="Allow linked computers to connect" checked={setup.listenerEnabled} disabled={busy || !setup.listenerAvailable} onchange={(enabled) => void run(() => manage("listener", { enabled }))} />{/snippet}
  </SettingsRow>
</SettingsGroup>
{#if loaded && !setup.listenerAvailable}
  <Alert tone="info">In the desktop app, enable “Allow other machines to connect” and choose an interface in Desktop settings. On a server, configure CANOPY_LINK_HOST and advertised addresses.</Alert>
{/if}
<SettingsGroup title="Linked computers" description="Pairing grants full access between your computers. Only link computers you own.">
  {#each setup.peers as computer (computer.nodeId)}
    <ComputerDetails {computer} {busy} onrename={() => edit(computer)} onunlink={() => { error = ""; remove = computer; removeOpen = true; }} />
  {:else}<SettingsRow title={loaded ? "No computers linked yet" : "Loading linked computers…"} description="Generate a code here, or enter a code from your other computer." />{/each}
</SettingsGroup>
{#if setup.peers.length}<SharedConfigOverview />{/if}
<Dialog bind:open title="Link a computer" description="Both computers belong to you and will have full access to each other.">
  <div class="grid min-w-0 gap-5">
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    {#if mode === "choose"}
      <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Open Linked computers on your other computer, then choose how to pair.</p>
      <Button variant="primary" disabled={busy || !setup.listenerEnabled} loading={busy} onclick={() => void invite()}>Generate pairing code</Button>
      {#if !setup.listenerEnabled}<p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Enable the listener above to generate a code on this computer.</p>{/if}
      <Button disabled={busy} onclick={() => { mode = "enter"; error = ""; }}>Enter code</Button>
    {:else if mode === "invite" && invitation}
      <div class="grid gap-2">
        <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Pairing code</p>
        <p class="select-all break-all rounded-xl bg-zinc-950/3 p-3 font-mono text-base/6 dark:bg-white/5">{invitation.code}</p>
        <div><Button size="sm" disabled={!remaining} onclick={() => void copy(invitation!.code, "code")}>{copied === "code" ? "Copied" : "Copy code"}</Button></div>
      </div>
      <div class="grid gap-2">
        <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Enter one of these addresses on the other computer</p>
        {#each invitation.addresses as value}<p class="select-all break-all font-mono text-base/6 sm:text-sm/6">{value}</p><div><Button size="sm" onclick={() => void copy(value, value)}>{copied === value ? "Copied" : "Copy address"}</Button></div>{/each}
      </div>
      <p role="status" class="tabular-nums text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">{remaining ? `One use · expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}` : "Code expired. Generate a new code."}</p>
      <Button disabled={busy} onclick={() => void invite()}>Generate new code</Button>
      <Button size="sm" variant="ghost" disabled={busy} onclick={() => void run(async () => { await manage("revoke_pairing"); invitation = undefined; mode = "choose"; })}>Revoke code</Button>
    {:else if mode === "enter"}
      <form class="grid gap-5" onsubmit={(event) => { event.preventDefault(); void run(async () => { setup = decode(ui.ComputersSnapshotSchema, await requestJson("POST", "/api/computers", { address, code }, 25_000)); open = false; }); }}>
        <Field label="Computer address"><Input bind:value={address} placeholder="https://computer:port" required autocomplete="off" /></Field>
        <Field label="Pairing code"><Input bind:value={code} placeholder="Paste the complete code" required autocomplete="off" spellcheck={false} /></Field>
        <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">The code verifies the other computer’s certificate before pairing. After linking, you can compare both fingerprints in Settings.</p>
        <Button type="submit" variant="primary" disabled={busy} loading={busy}>Link computers</Button>
      </form>
    {:else if mode === "linked"}
      <Alert tone="info">Computer linked. Compare this computer’s fingerprint with its entry on the other computer, and vice versa.</Alert>
      <Button variant="primary" onclick={() => { open = false; }}>Done</Button>
    {/if}
  </div>
</Dialog>
<Dialog bind:open={renameOpen} title="Rename computer" description="A linked computer’s display name is local to this computer.">
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  <form class="grid gap-5" onsubmit={(event) => { event.preventDefault(); void run(async () => { await manage("rename", { nodeId: rename!.nodeId, name }); renameOpen = false; }); }}>
    <Field label="Computer name"><Input bind:value={name} required maxlength={100} /></Field>
    <Button type="submit" variant="primary" disabled={busy} loading={busy}>Save name</Button>
  </form>
</Dialog>
<Dialog bind:open={removeOpen} title="Unlink computer" description="This removes mutual access and the pinned certificate. An offline computer learns about unlinking when it reconnects.">
  <div class="grid gap-4">
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <p class="text-base/6 sm:text-sm/6">Unlink {remove?.displayName || remove?.name}?</p>
    <Button variant="primary" disabled={busy} loading={busy} onclick={() => void run(async () => { await manage("unlink", { nodeId: remove!.nodeId }); removeOpen = false; })}>Unlink computer</Button>
  </div>
</Dialog>

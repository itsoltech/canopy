<script lang="ts">
  import { onMount } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { timestampDate } from "@bufbuild/protobuf/wkt";
  import type { ui } from "@canopy/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { pageIn } from "#lib/shared/ui/motion.ts";
  import WorkerInstallStep from "./WorkerInstallStep.svelte";
  import WorkerConnectionStatus from "./WorkerConnectionStatus.svelte";
  import WorkerProviderChoices from "./WorkerProviderChoices.svelte";
  import { workerAction } from "./actions.ts";
  import type { WorkerSetup } from "./worker-setup.svelte.ts";

  let { setup, open = $bindable(false), class: className }: { setup: WorkerSetup; open?: boolean; class?: ClassValue } = $props();
  const overview = useOverview();
  let step = $state(1);
  let name = $state("");
  let address = $state("");
  let invitation = $state<ui.WorkerEnrollment>();
  let token = $state("");
  let busy = $state(false);
  let error = $state("");
  let now = $state(Date.now());
  let direction = $state(1);
  const titles = ["Name your machine", "Set up the worker", "Connect to Canopy", "Choose providers"];
  const currentEnrollment = $derived(setup.enrollments.find((e) => e.id === invitation?.id) ?? invitation);
  const worker = $derived(overview.worker(currentEnrollment?.workerId ?? ""));
  const remaining = $derived(Math.max(0, Math.ceil(((currentEnrollment?.expiresAt ? timestampDate(currentEnrollment.expiresAt).getTime() : now) - now) / 1000)));
  const expired = $derived(!currentEnrollment?.usedAt && (remaining === 0 || Boolean(currentEnrollment?.revokedAt)));

  onMount(() => { const timer = setInterval(() => now = Date.now(), 1000); return () => clearInterval(timer); });
  $effect(() => {
    if (open) { address = setup.gatewayUrl; }
    else { step = 1; name = ""; token = ""; invitation = undefined; error = ""; }
  });
  function go(next: number) { direction = next > step ? 1 : -1; step = next; error = ""; }
  async function generate() {
    busy = true; error = "";
    try {
      if (address.trim() !== setup.gatewayUrl) await setup.saveAddress(address);
      // Revoke the previous invitation first; a lost response is recoverable from Pending enrollments.
      if (currentEnrollment && !currentEnrollment.usedAt && !currentEnrollment.revokedAt) await setup.revoke(currentEnrollment.id);
      const response = await workerAction("enroll", { name });
      invitation = response.enrollment; token = response.token;
      await setup.reload();
      go(2);
    } catch (e) { error = e instanceof Error ? e.message : "Could not create enrollment"; }
    finally { busy = false; }
  }
</script>

<Dialog bind:open title="Add worker" description="Connect another machine to your Canopy." size="lg" dismissible={!busy} class={className}>
  <div class="grid min-w-0 gap-5">
    <ol role="list" aria-label="Setup progress" class="grid grid-cols-4 gap-2">
      {#each ["Name", "Install", "Connect", "Providers"] as label, i}
        <li class="grid gap-2 text-xs/5 text-zinc-400 sm:text-sm/5" aria-current={step === i + 1 ? "step" : undefined}>
          <div class={["h-1 rounded-full", step >= i + 1 ? "bg-brand-600 dark:bg-brand-500" : "bg-zinc-950/10 dark:bg-white/10"]}></div>
          <p class={step === i + 1 ? "font-medium text-zinc-950 dark:text-white" : ""}>{i + 1}. {label}</p>
        </li>
      {/each}
    </ol>
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    {#key step}
      <div class="grid min-w-0 gap-4" in:pageIn={{ from: direction }}>
        <h3 class="text-base/7 font-semibold">{titles[step - 1]}</h3>
        {#if step === 1}
          <form class="grid gap-4" onsubmit={(e) => { e.preventDefault(); void generate(); }}>
            <Field label="Machine name" description="A name you will recognize, like MacBook or Home server."><Input name="worker-name" bind:value={name} maxlength={200} placeholder="MacBook Pro" data-autofocus required /></Field>
            <Field label="Gateway address for workers" description="The gRPC address this machine can reach, such as http://canopy-gateway:7443 over Tailscale. This is saved for future workers."><Input name="gateway-address" type="url" bind:value={address} placeholder="http://canopy-gateway:7443" required /></Field>
            <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Use the gateway’s gRPC port, not the web address. Use HTTPS on public networks or HTTP inside your trusted Tailscale network. The worker connects out; it needs no incoming ports.</p>
            <div class="flex justify-end"><Button variant="primary" type="submit" loading={busy} disabled={!name.trim() || !address.trim() || !setup.loaded}>Continue</Button></div>
          </form>
        {:else if step === 2}
          <WorkerInstallStep {name} gatewayUrl={setup.gatewayUrl} {token} version={setup.gatewayVersion} channel={setup.channel} copyable={!expired && !!token && !currentEnrollment?.usedAt} bind:busy
            onenrollment={(value) => { invitation = value; token = ""; void setup.reload(); }} oninstalled={() => go(3)} />
          <div class="flex flex-wrap items-center justify-between gap-3">
            <Button size="sm" variant="ghost" onclick={() => go(1)} disabled={busy}>Back</Button>
            <Button variant="primary" onclick={() => go(3)} disabled={busy || expired}>Check connection</Button>
          </div>
        {:else if step === 3}
          <WorkerConnectionStatus {worker} {name} />
          {#if overview.connection !== "live"}<Alert tone="warning">The live connection is recovering. Worker status will update when Canopy reconnects.</Alert>{/if}
          {#if expired}<Alert tone="warning">This token expired or was revoked. Generate a new token and use the updated command.</Alert>{/if}
          <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">The install script starts your user service automatically. For Docker, keep the container running. Manual installations use the startup commands printed by <code>canopy-worker service</code>.</p>
          <div class="flex flex-wrap items-center justify-between gap-3"><Button size="sm" variant="ghost" onclick={() => go(2)}>Show command</Button><Button variant="primary" disabled={!worker?.online} onclick={() => go(4)}>Choose providers</Button></div>
        {:else if worker}
          <WorkerProviderChoices workerId={worker.id} bind:busy />
          <div class="flex justify-end"><Button variant="primary" disabled={busy} onclick={() => open = false}>Finish</Button></div>
        {/if}
      </div>
    {/key}
    {#if step === 2 || step === 3}
      <div class="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-950/5 pt-4 text-sm/6 text-zinc-500 dark:border-white/10 dark:text-zinc-400">
        <p class="tabular-nums">{#if currentEnrollment?.usedAt}Token used · worker enrolled{:else if expired}Token unavailable{:else}Token expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}{/if}</p>
        {#if !currentEnrollment?.usedAt}<Button size="sm" loading={busy} onclick={() => void generate()}>Generate new token</Button>{/if}
      </div>
    {/if}
  </div>
</Dialog>

<script lang="ts">
  import { Provider, type ui } from "@canopy/contracts";
  import { providerLoginCommand } from "@canopy/domain/provider-accounts";
  import { formatRelative } from "#lib/shared/format.ts";
  import AccountStatusRow, { hasAccountStatus } from "./AccountStatusRow.svelte";
  import { signsInFromApp } from "./device-login.svelte.ts";
  import { kindLabel, statusOn } from "./instances.ts";
  import LoginPanel from "./LoginPanel.svelte";
  import StatusLine from "./StatusLine.svelte";
  import UsageMeters from "./UsageMeters.svelte";

  let {
    instance,
    worker,
    on,
    onupdated,
  }: {
    instance: ui.ProviderInstance;
    worker: ui.Worker;
    on: ui.InstanceOnWorker | undefined;
    onupdated: () => Promise<void>;
  } = $props();

  const accountShown = $derived(!!on?.enabled && hasAccountStatus(on.account, instance.harness));
  const appSignIn = $derived(signsInFromApp(instance.harness, instance.kind));
  const status = $derived(statusOn(on, worker.online));
</script>

<dl class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-base/6 sm:gap-x-6 sm:text-sm/6">
  <dt class="text-muted">Availability</dt>
  <dd><StatusLine {status} wrap /></dd>
  {#if on?.version}<dt class="text-muted">Version</dt>
    <dd class="font-mono wrap-anywhere">{on.version}</dd>{/if}
  {#if on?.reported && on.account?.authMethod !== "Proxy"}<dt class="text-muted">Connection</dt>
    <dd>{kindLabel(on.kind)}</dd>{/if}
  {#if on?.reported && !on.available && on.detail && on.detail.toLowerCase() !== status.label.toLowerCase()}
    <dt class="text-muted">Detail</dt>
    <dd class="text-pretty wrap-anywhere">{on.detail}</dd>{/if}
  {#if on?.checkedAt && !accountShown}<dt class="text-muted">Checked</dt>
    <dd>{formatRelative(on.checkedAt)}{on.synced ? "" : " · newer settings on their way"}</dd>
  {:else if on?.reported && !on.synced}
    <dt class="text-muted">Settings</dt>
    <dd>Newer settings on their way</dd>
  {/if}
  {#if on && accountShown}<dt class="text-muted">Account</dt>
    <dd class="-my-0.5 min-w-0">
      <AccountStatusRow
        account={on.account}
        workerId={worker.id}
        harness={instance.harness}
        id={instance.id}
        online={worker.online}
        os={worker.os}
        signInHere={appSignIn}
        {onupdated}
      />
    </dd>{/if}
</dl>

<UsageMeters usage={on?.usage} />
{#if appSignIn && on?.enabled}
  <LoginPanel {instance} {worker} {on} />
{:else if instance.harness === Provider.ANTIGRAVITY && on?.enabled && on.version && !on.authenticated && !accountShown}
  <p class="text-sm/6 wrap-anywhere text-muted">
    Run <code>{providerLoginCommand("antigravity", on.account, worker.os)}</code> on {worker.name} to sign in.
  </p>
{/if}

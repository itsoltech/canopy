<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import DeviceCode from "./DeviceCode.svelte";
  import { DeviceLogin, deviceLoginNote } from "./device-login.svelte.ts";
  import SignInConfirm from "./SignInConfirm.svelte";
  import { providerCall } from "./instances.ts";
  import { ACCOUNT_ACTION_LABELS, accountAction, providerLoginCommand } from "@canopy/domain/provider-accounts";
  import { Provider } from "@canopy/contracts";

  /**
   * The worker runs the official CLI flow and reports this login's result.
   * Device-login instances change the terminal account; own-login instances change only their isolated store.
   */
  let {
    instance,
    worker,
    on,
    class: className,
  }: { instance: ui.ProviderInstance; worker: ui.Worker; on: ui.InstanceOnWorker; class?: ClassValue } = $props();

  const linked = $derived(instance.runtime?.ownLogin !== true);

  const harness = $derived(
    instance.harness === Provider.CLAUDE ? "claude" : instance.harness === Provider.GROK ? "grok" : "codex",
  );

  // A worker without an account report still says whether the CLI is signed in.
  const action = $derived(
    ACCOUNT_ACTION_LABELS[on.account ? accountAction(on.account) : on.authenticated ? "change_account" : "sign_in"],
  );

  let confirming = $state<"login" | "logout">();
  let signingOut = $state(false);

  async function logout() {
    signingOut = true;

    try {
      await providerCall("logout", { harness: instance.harness, id: instance.id, workerId: worker.id }, 70_000);
      confirming = undefined;
    } catch (error) {
      login.failure = error instanceof Error ? error.message : "Could not sign out. Refresh, then retry.";
    } finally {
      signingOut = false;
    }
  }

  const login = new DeviceLogin(() => ({
    harness: instance.harness,
    id: instance.id,
    workerId: worker.id,
    account: on.account,
  }));

  $effect(() => login.settle());
</script>

<div class={["grid gap-3", className]}>
  {#if login.code}
    <DeviceCode
      {...login.code}
      url={login.code.url}
      workerName={worker.name}
      busy={login.busy}
      onsubmit={(code) => login.submit(code)}
    />
  {:else if confirming === "login"}
    <SignInConfirm
      workerName={worker.name}
      {linked}
      harness={instance.harness}
      {action}
      busy={login.busy}
      onstart={() =>
        login.start().then(() => {
          confirming = undefined;
        })}
      oncancel={() => {
        confirming = undefined;
      }}
    />
  {:else if confirming === "logout"}
    <div class="grid gap-2 rounded-xl bg-zinc-950/2.5 p-4 dark:bg-white/2.5">
      <p class="text-sm/6 break-words text-zinc-700 dark:text-zinc-300">
        {linked
          ? `This signs out the CLI on ${worker.name}, including in your terminal.`
          : `This signs out only this instance on ${worker.name}.`}
      </p>
      <div class="flex flex-wrap gap-2">
        <Button
          variant="ghost"
          onclick={() => {
            confirming = undefined;
          }}>Cancel</Button
        >
        <Button loading={signingOut} onclick={logout}>Sign out</Button>
      </div>
    </div>
  {:else}
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button
        icon="user"
        loading={login.busy}
        disabled={!worker.online}
        onclick={() => {
          confirming = "login";
        }}>{action}</Button
      >
      {#if on.account?.state !== "signed_out"}
        <Button
          disabled={!worker.online}
          onclick={() => {
            confirming = "logout";
          }}>Sign out</Button
        >
      {/if}
      {#if !worker.online}<p class="text-sm/5 text-zinc-500">The worker is offline.</p>
      {:else if linked}<p class="min-w-0 text-sm/5 text-zinc-500 dark:text-zinc-400">
          {deviceLoginNote(worker.name, instance.harness)}
        </p>{/if}
    </div>
  {/if}
  {#if login.failure}
    <Alert tone="error">{login.failure}</Alert>
    <p class="text-sm/6 break-words text-zinc-600 dark:text-zinc-400">
      Sign in with <code
        >{on.account
          ? providerLoginCommand(harness, on.account, worker.os)
          : `${harness} ${harness === "claude" ? "auth login" : "login"}`}</code
      >
      in a terminal on {worker.name}.
    </p>
  {/if}
</div>

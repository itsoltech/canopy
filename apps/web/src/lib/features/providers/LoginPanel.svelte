<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import DeviceCode from "./DeviceCode.svelte";
  import { DeviceLogin, deviceLoginNote } from "./device-login.svelte.ts";

  /**
   * Sign-in from the app for a Codex instance (Codex app-server account/login with a ChatGPT device code): the worker
   * starts it, the user opens the link anywhere and enters the code; the worker finishes it and reports the login.
   * An instance on the device login signs the device's Codex in again; one with its own login, only itself.
   */
  let {
    instance,
    worker,
    on,
    class: className,
  }: { instance: ui.ProviderInstance; worker: ui.Worker; on: ui.InstanceOnWorker; class?: ClassValue } = $props();

  const linked = $derived(instance.runtime?.ownLogin !== true);

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
    <DeviceCode url={login.code.url} userCode={login.code.userCode} workerName={worker.name} />
  {:else}
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button icon="user" loading={login.busy} disabled={!worker.online} onclick={() => login.start()}
        >{on.authenticated ? "Sign in again with ChatGPT" : "Continue with ChatGPT"}</Button
      >
      {#if !worker.online}<p class="text-sm/5 text-zinc-500">The worker is offline.</p>
      {:else if linked}<p class="min-w-0 text-sm/5 text-zinc-500 dark:text-zinc-400">
          {deviceLoginNote(worker.name)}
        </p>{/if}
    </div>
  {/if}
  {#if login.failure}<Alert tone="error">{login.failure}</Alert>{/if}
</div>

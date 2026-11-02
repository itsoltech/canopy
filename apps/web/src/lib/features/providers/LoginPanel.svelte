<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { rise } from "#lib/shared/ui/motion.ts";
  import { providerCall } from "./instances.ts";

  /**
   * Sign-in from the app for a Codex instance with its own login (Codex app-server account/login with a ChatGPT device
   * code): the worker starts it, the user opens the link anywhere and enters the code; the worker finishes it and
   * reports the login (the status line turns "Authenticated · ChatGPT").
   */
  let { instance, worker, signedIn }: { instance: ui.ProviderInstance; worker: ui.Worker; signedIn: boolean } = $props();

  let code = $state<{ url: string; userCode: string }>();
  let busy = $state(false);
  let failure = $state<string>();
  $effect(() => {
    if (signedIn) code = undefined;
  });

  async function start() {
    busy = true;
    failure = undefined;
    try {
      const started = await providerCall("login", { harness: instance.harness, id: instance.id, workerId: worker.id }, 70_000);
      code = { url: started.verificationUrl, userCode: started.userCode };
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }
</script>

<div class="grid gap-3">
  {#if code}
    <div class="grid gap-2 rounded-xl bg-zinc-950/2.5 p-4 dark:bg-white/2.5" in:rise>
      <p class="text-base/6 text-zinc-700 sm:text-sm/6 dark:text-zinc-300">Open the link, sign in with ChatGPT and enter this code. It expires in 15 minutes.</p>
      <p class="font-mono text-2xl font-semibold tracking-widest text-zinc-950 select-all dark:text-white">{code.userCode}</p>
      <a href={code.url} target="_blank" rel="noreferrer noopener" class="inline-flex items-center gap-1.5 text-base/6 font-medium text-brand-700 hover:underline focus-ring sm:text-sm/6 dark:text-brand-400">
        {code.url}<Icon name="arrow-top-right-on-square" class="size-4 fill-current" />
      </a>
      <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">Waiting for the sign-in on {worker.name}…</p>
    </div>
  {:else}
    <div class="flex flex-wrap items-center gap-3">
      <Button icon="user" loading={busy} disabled={!worker.online} onclick={start}>{signedIn ? "Sign in again with ChatGPT" : "Continue with ChatGPT"}</Button>
      {#if !worker.online}<p class="text-sm/5 text-zinc-500">The worker is offline.</p>{/if}
    </div>
  {/if}
  {#if failure}<Alert tone="error">{failure}</Alert>{/if}
</div>

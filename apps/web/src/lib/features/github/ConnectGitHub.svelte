<script lang="ts">
  import { onMount } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import type { github } from "@canopy/contracts";
  import { timestampDate } from "@bufbuild/protobuf/wkt";
  import * as api from "./api.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";

  let {
    homeId = "",
    configured = true,
    onconnected,
    class: className,
  }: {
    homeId?: string;
    configured?: boolean;
    onconnected?: () => void;
    class?: ClassValue;
  } = $props();

  let attempt = $state<github.GitHubDeviceAuth>();
  let busy = $state(false);
  let error = $state("");
  let copied = $state(false);
  const key = () => `canopy:github-sign-in:${homeId}`;
  let notified = "";
  let alive = true;

  function update(value: github.GitHubDeviceAuthResponse) {
    if (!alive) return;
    attempt = value.attempt;

    if (!attempt) return;
    sessionStorage.setItem(key(), attempt.id);

    if (attempt.state === "connected" && notified !== attempt.id) {
      notified = attempt.id;
      onconnected?.();
    }
  }

  async function run(action: () => Promise<github.GitHubDeviceAuthResponse>) {
    if (busy) return;
    busy = true;
    error = "";

    try {
      update(await action());
    } catch {
      if (alive) error = "Could not check GitHub sign-in. Check the connection, then retry.";
    } finally {
      busy = false;
    }
  }

  async function start() {
    copied = false;
    const requestKey = `${key()}:request`;

    const request =
      attempt && attempt.state !== "pending"
        ? crypto.randomUUID()
        : sessionStorage.getItem(requestKey) || crypto.randomUUID();

    sessionStorage.setItem(requestKey, request);
    await run(() => api.begin(homeId, request));
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(attempt?.userCode ?? "");
      copied = true;
    } catch {
      error = "Could not copy the code. Select it and copy it manually.";
    }
  }

  onMount(() => {
    alive = true;
    const id = sessionStorage.getItem(key());

    if (id) void run(() => api.status(id));

    const poll = () => {
      // SAFETY: run invokes this callback synchronously after the pending-attempt guard.
      if (attempt?.state === "pending" && !document.hidden) void run(() => api.status(attempt!.id));
    };

    const timer = setInterval(poll, 2000);
    document.addEventListener("visibilitychange", poll);

    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  });
</script>

<div class={["flex min-w-0 flex-col gap-3", className]}>
  {#if !configured}
    <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      GitHub account sign-in is not configured on this computer yet. Existing personal access tokens from Connectors can
      be used here when available.
    </p>
  {:else if attempt?.state === "pending"}
    <div class="flex flex-col gap-3 rounded-lg bg-zinc-950/3 p-4 dark:bg-white/5">
      <p class="text-base/6 text-zinc-600 sm:text-sm/6 dark:text-zinc-300">
        Enter this code on GitHub to connect your account.
      </p>
      <p class="font-mono text-2xl font-semibold tracking-wider text-zinc-950 select-all dark:text-white">
        {attempt.userCode}
      </p>
      <div class="flex flex-wrap gap-2">
        <Button onclick={copy} size="sm">Copy code</Button>
        {#if attempt.verificationUri === "https://github.com/login/device"}<ButtonLink
            href={attempt.verificationUri}
            target="_blank"
            rel="noreferrer"
            size="sm">Open GitHub</ButtonLink
          >{/if}
        <!-- SAFETY: this action is rendered only for the pending attempt; run invokes its callback synchronously. -->
        <Button onclick={() => run(() => api.cancel(attempt!.id))} disabled={busy} size="sm">Cancel</Button>
      </div>
      <div class="min-h-6 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400" role="status">
        {copied ? "Code copied. " : ""}Waiting for GitHub. Expires at {attempt.expiresAt
          ? timestampDate(attempt.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : "—"}.
      </div>
    </div>
  {:else}
    {#if attempt}<p class="text-base/6 text-zinc-600 sm:text-sm/6 dark:text-zinc-300" role="status">
        {attempt.state === "connected"
          ? "GitHub account connected."
          : attempt.state === "expired"
            ? "The code expired. Start again to get a new code."
            : attempt.state === "denied"
              ? "GitHub sign-in was denied. You can try again when you are ready."
              : attempt.state === "cancelled"
                ? "GitHub sign-in cancelled."
                : "GitHub sign-in could not finish. Start again to get a new code."}
      </p>{/if}
    <div>
      <Button variant="primary" onclick={start} disabled={busy}>{busy ? "Connecting…" : "Connect GitHub"}</Button>
    </div>
  {/if}
  {#if error}<Alert
      >{error}<!-- SAFETY: the conditional narrows the attempt before run invokes the callback synchronously. --><Button
        onclick={() => (attempt?.state === "pending" ? run(() => api.status(attempt!.id)) : start())}
        size="sm">Retry</Button
      ></Alert
    >{/if}
</div>

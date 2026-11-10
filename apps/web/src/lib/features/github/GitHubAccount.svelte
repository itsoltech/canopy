<script lang="ts">
  import { onMount } from "svelte";
  import type { github } from "@canopy/contracts";
  import * as api from "./api.ts";
  import GitHubInstallation from "./GitHubInstallation.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";

  let {
    account,
    installUrl,
    onchanged,
    class: className = "",
  }: { account: github.GitHubAccount; installUrl: string; onchanged: () => void; class?: string } = $props();

  let installations = $state<github.GitHubInstallation[]>([]);
  let next = $state(0);
  let busy = $state(false);
  let loaded = $state(false);
  let confirming = $state(false);
  let error = $state("");
  let generation = $state(0);

  async function load(page = 0, refresh = false) {
    if (busy || account.status !== "connected" || account.authKind === "pat") return;
    busy = true;
    error = "";

    try {
      const value = await api.installations(account.id, page, refresh);
      installations = page ? [...installations, ...value.installations] : value.installations;
      next = value.nextPage;
      loaded = true;

      if (!page) generation++;
    } catch {
      error = "Could not refresh GitHub installations. Check access on GitHub, then retry.";
      onchanged();
    } finally {
      busy = false;
    }
  }

  async function disconnect() {
    busy = true;

    try {
      await api.disconnect(account.id);
      onchanged();
    } catch {
      error = "Could not disconnect this account. Check the connection, then retry.";
    } finally {
      busy = false;
      confirming = false;
    }
  }

  onMount(() => {
    void load();

    const focus = () => {
      if (!document.hidden) void load(0, true);
    };

    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 900_000);

    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);

    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  });
</script>

<section
  class={["flex min-w-0 flex-col gap-4 border-t border-zinc-950/10 py-5 dark:border-white/10", className]}
  aria-label={account.login}
>
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0 flex-1">
      <h2 class="text-base font-semibold wrap-anywhere">{account.login}</h2>
      <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        {account.host} · {account.authKind === "pat" ? "Personal access token" : "GitHub App"} · {account.status ===
        "connected"
          ? "Connected"
          : account.status === "needs_reconnect"
            ? "Reconnect required"
            : "Disconnected"}
      </p>
    </div>
    {#if account.status !== "disconnected"}<Button
        size="sm"
        onclick={() => {
          confirming = true;
        }}>Disconnect account</Button
      >{/if}
  </div>
  <Dialog bind:open={confirming} title="Disconnect account?" dismissible={!busy}>
    <div class="flex flex-col gap-4">
      <p class="text-base/6 text-zinc-600 sm:text-sm/6 dark:text-zinc-300">
        This removes this account’s access from this computer. To revoke authorization on every computer, open GitHub
        Settings → Applications → Authorized GitHub Apps.
      </p>
      <DialogActions>
        <Button
          data-autofocus
          disabled={busy}
          onclick={() => {
            confirming = false;
          }}>Cancel</Button
        >
        <Button variant="danger" disabled={busy} onclick={disconnect}>Disconnect account</Button>
      </DialogActions>
    </div>
  </Dialog>
  {#if error}<Alert tone="error"
      >{error}
      <div class="mt-2"><Button size="sm" disabled={busy} onclick={() => load(0, true)}>Retry</Button></div></Alert
    >{/if}
  {#if account.status === "connected"}
    {#if account.authKind === "pat"}<p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        This account uses the personal access token you selected in Connectors.
      </p>
    {:else}
      {#if busy && !loaded}<p role="status" class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          Loading installations…
        </p>{/if}
      {#each installations as installation (`${generation}:${installation.installationId}`)}<GitHubInstallation
          accountId={account.id}
          {installation}
        />{/each}
      {#if loaded && !installations.length}<p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          No accessible installations. Install Canopy and choose repositories, or ask an organization administrator to
          approve access.
        </p>{/if}
      <div class="flex flex-wrap gap-2">
        {#if installUrl}<ButtonLink size="sm" href={installUrl} target="_blank" rel="noreferrer"
            >Install Canopy</ButtonLink
          >{/if}<Button size="sm" disabled={busy} onclick={() => load(0, true)}>Refresh installations</Button
        >{#if next}<Button size="sm" disabled={busy} onclick={() => load(next)}>Load more installations</Button>{/if}
      </div>
    {/if}
  {/if}
  <div>
    <ButtonLink size="sm" href="https://github.com/settings/apps/authorizations" target="_blank" rel="noreferrer"
      >Manage authorization on GitHub</ButtonLink
    >
  </div>
</section>

<script lang="ts">
  import { onMount } from "svelte";
  import type { github } from "@canopy/contracts";
  import * as api from "./api.ts";
  import GitHubInstallation from "./GitHubInstallation.svelte";
  import GitHubAvatar from "./GitHubAvatar.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import MenuSeparator from "#lib/shared/ui/MenuSeparator.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { expand } from "#lib/shared/ui/motion.ts";
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
  let expanded = $state(false);
  let all = $state(false);
  let menuOpen = $state(false);
  let total = $state<number>();
  let repositoryCount = $state<number>();
  const shown = $derived(all ? installations : installations.slice(0, 5));
  const installationCount = $derived(total ?? account.installationCount);
  const repositoryTotal = $derived(repositoryCount ?? account.repositoryCount);

  const status = $derived(
    account.status === "connected"
      ? "Connected"
      : account.status === "needs_reconnect"
        ? "Reconnect required"
        : "Disconnected",
  );

  const openGitHub = (url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
  };

  async function load(page = 0, refresh = false) {
    if (busy || account.status !== "connected" || account.authKind === "pat") return;
    busy = true;
    error = "";

    try {
      const value = await api.installations(account.id, page, refresh);
      installations = page ? [...installations, ...value.installations] : value.installations;
      next = value.nextPage;
      total = value.totalCount;
      repositoryCount = value.repositoryCount;
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

<section class={["@container min-w-0", className]} aria-label={account.login}>
  <div
    class={[
      "flex min-w-0 items-center gap-2 px-3 hover:bg-zinc-950/3 has-focus-visible:bg-zinc-950/3 dark:hover:bg-white/5 dark:has-focus-visible:bg-white/5",
      menuOpen && "bg-zinc-950/3 dark:bg-white/5",
    ]}
  >
    <button
      type="button"
      aria-expanded={expanded}
      onclick={() => (expanded = !expanded)}
      class="grid min-h-16 min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 rounded-lg py-2 text-left focus-ring @min-[36rem]:min-h-14 @min-[36rem]:grid-cols-[auto_minmax(0,1fr)_auto]"
    >
      <GitHubAvatar userId={account.githubUserId} login={account.login} class="row-span-3 @min-[36rem]:row-span-2" />
      <div class="col-start-2 row-start-1 min-w-0 text-base/5 font-medium sm:text-sm/5">
        <TruncatedText text={account.login} />
      </div>
      <p class="col-start-2 row-start-2 min-w-0 truncate text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
        {account.authKind === "pat" ? "Personal access token" : "GitHub App"} · {status}
      </p>
      {#if account.authKind !== "pat" && account.status === "connected"}<p
          class="col-start-2 row-start-3 text-sm/5 text-zinc-500 tabular-nums sm:text-xs/5 @min-[36rem]:col-start-3 @min-[36rem]:row-span-2 @min-[36rem]:row-start-1 dark:text-zinc-400"
        >
          {installationCount}
          {installationCount === 1 ? "installation" : "installations"} · {repositoryTotal}
          {repositoryTotal === 1 ? "repo" : "repos"}
        </p>{/if}
    </button>
    <span class="shrink-0" aria-hidden="true"
      ><Icon name="chevron-right" class={["t-acc-chevron text-zinc-400", expanded && "rotate-90"]} /></span
    >
    <DropdownMenu bind:open={menuOpen} label={`Actions for ${account.login}`} placement="bottom-end" sheet>
      {#snippet trigger(props)}<IconButton
          icon="ellipsis-horizontal"
          label={`Actions for ${account.login}`}
          size="sm"
          {...props}
        />{/snippet}
      {#if account.authKind !== "pat"}<MenuItem
          disabled={busy || account.status !== "connected"}
          onselect={() => {
            void load(0, true);
          }}>Refresh installations</MenuItem
        >{/if}
      {#if installUrl && account.authKind !== "pat"}<MenuItem onselect={() => openGitHub(installUrl)}
          >Install on another account</MenuItem
        >{/if}
      <MenuItem onselect={() => openGitHub("https://github.com/settings/apps/authorizations")}
        >Manage authorization on GitHub</MenuItem
      >
      <MenuSeparator />
      <MenuItem danger disabled={busy || account.status === "disconnected"} onselect={() => (confirming = true)}
        >Disconnect account</MenuItem
      >
    </DropdownMenu>
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
  {#if error}<Alert tone="error" class="m-3"
      >{error}
      <div class="mt-2"><Button size="sm" disabled={busy} onclick={() => load(0, true)}>Retry</Button></div></Alert
    >{/if}
  {#if expanded}<div transition:expand={{ instantReduced: true }}>
      <div class="grid min-w-0 gap-2 border-t border-zinc-950/5 px-3 py-2 dark:border-white/8">
        {#if account.status === "connected"}
          {#if account.authKind === "pat"}<p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
              This account uses the personal access token you selected in Connectors.
            </p>
          {:else}
            {#if busy && !loaded}<p role="status" class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
                Loading installations…
              </p>{/if}
            <div class={["min-w-0", all && "max-h-96 overflow-y-auto overscroll-contain"]}>
              {#each shown as installation (`${generation}:${installation.installationId}`)}<GitHubInstallation
                  accountId={account.id}
                  {installation}
                  {installUrl}
                />{/each}
            </div>
            {#if loaded && !installations.length}<p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
                No accessible installations. Install Canopy and choose repositories, or ask an organization
                administrator to approve access.
              </p>{/if}
            {#if installationCount > 5}<div>
                <Button variant="ghost" size="sm" onclick={() => (all = !all)}
                  >{all ? "Show fewer installations" : `Show all ${installationCount} installations`}</Button
                >
              </div>{/if}
            {#if all && next}<div>
                <Button size="sm" disabled={busy} onclick={() => load(next)}>Load more installations</Button>
              </div>{/if}
          {/if}
        {/if}
      </div>
    </div>{/if}
</section>

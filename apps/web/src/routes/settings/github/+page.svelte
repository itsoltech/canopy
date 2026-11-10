<script lang="ts">
  import { onMount } from "svelte";
  import type { github } from "@canopy/contracts";
  import { GITHUB_ACCOUNTS, GITHUB_HOME, qualifyId } from "@canopy/domain/computers";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import SettingsHeading from "#lib/features/settings/SettingsHeading.svelte";
  import ConnectGitHub from "#lib/features/github/ConnectGitHub.svelte";
  import GitHubAccount from "#lib/features/github/GitHubAccount.svelte";
  import * as api from "#lib/features/github/api.ts";
  import Select from "#lib/shared/ui/Select.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import InsetList from "#lib/shared/ui/InsetList.svelte";

  const overview = useOverview();
  let homeId = $state("");
  let data = $state<github.GitHubAccountsResponse>();
  let error = $state("");
  let busy = $state(false);
  let mounted = $state(false);

  const homes = $derived([
    { value: "", label: "This computer" },
    ...overview.computers
      .values()
      .filter((c) => !c.viaNodeId)
      .map((c) => ({
        value: qualifyId(GITHUB_HOME, c.nodeId),
        label: c.displayName || c.name,
        disabled: c.status !== "connected" || !c.capabilities.includes(GITHUB_ACCOUNTS),
      }))
      .toArray(),
  ]);

  async function reload(home = homeId) {
    try {
      const value = await api.accounts(home);

      if (home === homeId) {
        data = value;
        error = "";
      }
    } catch {
      if (home === homeId) error = "Could not load GitHub accounts. Check the home computer's connection, then retry.";
    }
  }

  async function usePat(id: string) {
    busy = true;

    try {
      await api.usePat(homeId, id);
      await reload();
    } catch {
      error = "Could not use this personal access token. Reconnect it in Settings → Connectors, then retry.";
    } finally {
      busy = false;
    }
  }

  $effect(() => {
    if (mounted) {
      data = undefined;
      void reload(homeId);
    }
  });

  onMount(() => {
    mounted = true;

    const focus = () => {
      if (!document.hidden) void reload();
    };

    window.addEventListener("focus", focus);

    return () => window.removeEventListener("focus", focus);
  });
</script>

<div class="flex min-w-0 flex-col gap-6 text-zinc-950 dark:text-white">
  <SettingsHeading title="GitHub" description="Connect accounts and choose which repositories Canopy can access." />
  {#if homes.length > 1}<div class="flex flex-col gap-2">
      <p class="text-base font-medium sm:text-sm">Store accounts on</p>
      <Select
        aria-label="Store GitHub accounts on"
        value={homeId}
        options={homes}
        onchange={(value) => {
          homeId = value;
        }}
      />
      <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        Accounts and tokens stay on the selected computer. It must be online to connect or refresh access.
      </p>
    </div>{/if}
  {#if error}<Alert tone="error"
      >{error}
      <div class="mt-2"><Button size="sm" onclick={() => reload()}>Retry</Button></div></Alert
    >{/if}
  {#if data}
    {#key homeId}<ConnectGitHub
        {homeId}
        configured={data.configured}
        hasAccounts={data.accounts.length > 0}
        onconnected={() => {
          void reload();
        }}
      />{/key}
    {#if data.patCandidates.length}<section class="flex flex-col gap-3">
        <h2 class="text-base font-semibold">Use an existing personal access token</h2>
        <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          Choose a GitHub account from Connectors explicitly. Canopy checks its GitHub identity before using it.
        </p>
        <div class="flex flex-wrap gap-2">
          {#each data.patCandidates as pat (pat.connectorAccountId)}<Button
              size="sm"
              disabled={busy}
              onclick={() => usePat(pat.connectorAccountId)}>Use {pat.name}</Button
            >{/each}
        </div>
      </section>{/if}
    {#if data.accounts.length}<InsetList label="GitHub accounts">
        {#each data.accounts as account (`${homeId}:${account.id}:${account.revision}`)}<li>
            <GitHubAccount
              {account}
              installUrl={data.installUrl}
              onchanged={() => {
                void reload();
              }}
            />
          </li>{/each}
      </InsetList>{:else}<p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        No GitHub accounts connected on this computer.
      </p>{/if}
  {:else if !error}<p role="status" class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      Loading GitHub accounts…
    </p>{/if}
</div>

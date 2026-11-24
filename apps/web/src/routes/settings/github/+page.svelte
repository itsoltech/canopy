<script lang="ts">
  import SettingsTopics from "#lib/features/settings/SettingsTopics.svelte";
  import { onMount, tick } from "svelte";
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
  let topics = $state<ReturnType<typeof SettingsTopics>>();
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

  async function connected(home: string, showAccount: boolean) {
    await reload(home);
    await tick();

    if (showAccount && home === homeId && !error && data?.accounts.length) topics?.selectTopic("accounts");
  }

  async function usePat(id: string) {
    const home = homeId;
    busy = true;

    try {
      await api.usePat(home, id);
      await connected(home, true);
    } catch {
      if (home === homeId)
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
    {@const current = data}
    <SettingsTopics
      bind:this={topics}
      label="GitHub settings"
      topics={[
        { id: "accounts", label: "Accounts and access", content: accounts, hidden: !current.accounts.length },
        { id: "connect", label: "Connect account", content: connect },
      ]}
    />
    {#snippet accounts()}
      <InsetList label="GitHub accounts">
        {#each current.accounts as account (`${homeId}:${account.id}:${account.revision}`)}<li>
            <GitHubAccount
              {account}
              installUrl={current.installUrl}
              onchanged={() => {
                void reload();
              }}
            />
          </li>{/each}
      </InsetList>
    {/snippet}
    {#snippet connect()}
      {#key homeId}<ConnectGitHub
          {homeId}
          configured={current.configured}
          hasAccounts={current.accounts.length > 0}
          onconnected={(justConnected) => void connected(homeId, justConnected)}
        />{/key}
      {#if current.patCandidates.length}<section class="flex flex-col gap-3">
          <h2 class="text-base font-semibold">Existing personal access tokens</h2>
          <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
            Canopy verifies the GitHub account for each token you use from Connectors.
          </p>
          <div class="flex flex-wrap gap-2">
            {#each current.patCandidates as pat (pat.connectorAccountId)}<Button
                size="sm"
                disabled={busy}
                onclick={() => usePat(pat.connectorAccountId)}>Use {pat.name}</Button
              >{/each}
          </div>
        </section>{/if}
    {/snippet}
  {:else if !error}<p role="status" class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      Loading GitHub accounts…
    </p>{/if}
</div>

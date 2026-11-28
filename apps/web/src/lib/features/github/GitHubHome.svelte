<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { github } from "@canopy/contracts";
  import SettingsTopics from "#lib/features/settings/SettingsTopics.svelte";
  import ConnectGitHub from "./ConnectGitHub.svelte";
  import GitHubAccount from "./GitHubAccount.svelte";
  import GitHubAgentAccess from "./GitHubAgentAccess.svelte";
  import * as api from "./api.ts";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import InsetList from "#lib/shared/ui/InsetList.svelte";

  let { homeId, agentAccessAvailable }: { homeId: string; agentAccessAvailable: boolean } = $props();
  const capabilities = useGatewayCapabilities();
  let topics = $state<ReturnType<typeof SettingsTopics>>();
  let data = $state<github.GitHubAccountsResponse>();
  let error = $state("");
  let patError = $state("");
  let busy = $state(false);
  let editing = $state<{ repository: api.AgentRepository; removeOnly: boolean }>();
  let latest = 0;

  async function reload() {
    const request = ++latest;

    try {
      const value = await api.accounts(homeId);

      if (request === latest) {
        data = value;
        error = "";
      }
    } catch {
      if (request === latest)
        error = "Could not load GitHub accounts. Check the home computer’s connection, then retry.";
    }
  }

  async function connected(showAccount: boolean) {
    await reload();
    await tick();

    if (showAccount && !error && data?.accounts.length) topics?.selectTopic("accounts");
  }

  async function usePat(id: string) {
    patError = "";
    busy = true;

    try {
      await api.usePat(homeId, id);
      await connected(true);
    } catch {
      patError = homeId
        ? "Could not use this token. Reconnect it in Connectors on the selected computer, then retry."
        : "Could not use this token. Reconnect it in Connectors, then retry.";
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void reload();

    const focus = () => {
      if (!document.hidden) void reload();
    };

    window.addEventListener("focus", focus);

    return () => {
      latest++;
      window.removeEventListener("focus", focus);
    };
  });
</script>

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
            onaccess={!agentAccessAvailable || capabilities?.supportsMethod("SetGitHubAgentAccess") === false
              ? undefined
              : (repositoryId, repositoryName, removeOnly = false) => {
                  editing = { repository: { accountId: account.id, repositoryId, repositoryName }, removeOnly };
                }}
            onchanged={() => {
              void reload();
            }}
          />
        </li>{/each}
    </InsetList>
  {/snippet}
  {#snippet connect()}
    <ConnectGitHub
      {homeId}
      configured={current.configured}
      hasAccounts={current.accounts.length > 0}
      onconnected={(justConnected) => void connected(justConnected)}
    />
    <Disclosure summaryClass="min-h-10 items-center text-base font-medium sm:text-sm">
      {#snippet summary()}Advanced connections{/snippet}
      <div class="grid min-w-0 gap-4 pt-2 pl-6">
        {#if current.patCandidates.length}
          <section class="grid gap-2">
            <h2 class="text-base font-medium sm:text-sm">Existing personal access tokens</h2>
            <div class="flex flex-wrap gap-2">
              {#each current.patCandidates as pat (pat.connectorAccountId)}
                <Button size="sm" disabled={busy} onclick={() => usePat(pat.connectorAccountId)}>Use {pat.name}</Button>
              {/each}
            </div>
            {#if patError}<Alert tone="error">{patError}</Alert>{/if}
          </section>
        {/if}
        {#if !homeId}
          <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">
            Connect to GitHub’s MCP server with a personal access token or your own OAuth app.
          </p>
          <div class="flex flex-wrap gap-2">
            <ButtonLink size="sm" href="/settings/connectors?add=github">Connect GitHub MCP</ButtonLink>
            <ButtonLink size="sm" href="/settings/connectors?add=custom">Connect custom MCP server</ButtonLink>
          </div>
        {:else}
          <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">
            Open Connectors on the selected computer to manage its MCP accounts and personal access tokens.
          </p>
        {/if}
      </div>
    </Disclosure>
  {/snippet}
{:else if !error}<p role="status" class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
    Loading GitHub accounts…
  </p>{/if}
{#if editing}
  {#key editing}
    <GitHubAgentAccess {...editing} onclose={() => (editing = undefined)} onsaved={() => void reload()} />
  {/key}
{/if}

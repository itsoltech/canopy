<script lang="ts">
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { botList } from "#lib/features/bots/bot-list.svelte.ts";
  import { onMount, untrack } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { connectors } from "@canopy/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettingsRoute } from "#lib/features/settings/settings-route.ts";
  import SettingsHeading from "#lib/features/settings/SettingsHeading.svelte";
  import ConnectorIcon from "#lib/features/connectors/ConnectorIcon.svelte";
  import ConnectAccountDialog from "#lib/features/connectors/ConnectAccountDialog.svelte";
  import AccountDetail from "#lib/features/connectors/AccountDetail.svelte";
  import SlackBotConnections from "#lib/features/connectors/SlackBotConnections.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import InsetList from "#lib/shared/ui/InsetList.svelte";
  import { decode } from "#lib/shared/wire.ts";
  import { completeConnectorOAuth, listConnectors } from "#lib/features/connectors/api.ts";
  import type { PageProps } from "./$types";
  import ConfigNotices from "#lib/features/computers/ConfigNotices.svelte";
  import ConnectionError from "#lib/features/connectors/ConnectionError.svelte";

  let { data }: PageProps = $props();
  const settings = useSettings();
  const overview = useOverview();

  const projects = $derived(
    overview.ownProjects.flatMap(({ id, name, archivedAt, kind }) =>
      !archivedAt && kind !== "scratch" ? [{ id, name }] : [],
    ),
  );

  const route = useSettingsRoute();
  let catalog = $state(untrack(() => decode(connectors.ListConnectorsResponseSchema, data.connections)));

  let accounts = $state<connectors.ConnectorAccount[]>(
    untrack(() => decode(connectors.ListConnectorsResponseSchema, data.connections).accounts),
  );

  let reloading = false;
  let reloadAgain = false;
  const CONNECTORS_FALLBACK_MS = 30_000;

  // Connector grants use the shared bot list only while bot access controls are visible.
  $effect(() => (settings.moduleEnabled("bots") ? botList.use() : undefined));

  const bots = $derived(
    botList.list
      .filter((b) => !b.archived)
      .map((b) => ({
        id: b.id,
        name: b.configuration?.name ?? "Bot",
      })),
  );

  const unavailable = $derived(settings.moduleEnabled("bots") ? botList.unavailableComputers : []);
  const refreshing = $derived(settings.moduleEnabled("bots") ? botList.refreshingComputers : []);

  let selected = $state("");
  let connecting = $state(false);
  let addingSlackBot = $state(false);
  let slackBotReady = $state(false);
  let oauthCompletion = $state<connectors.CompleteConnectorOAuthResponse>();
  let oauthError = $state<connectors.ConnectorError>();
  let notice = $state(untrack(() => route.url.searchParams.get("connection")));
  const type = $derived(catalog.types.find((t) => t.id === selected));

  $effect(() => {
    const next = decode(connectors.ListConnectorsResponseSchema, data.connections);
    catalog = next;
    accounts = next.accounts;
  });

  // Route data refreshes on desktop returns, including when this page is already open.
  // The code comes over the desktop bridge, never in the URL.
  $effect(() => {
    void data.connections;
    void window.canopyDesktop?.takeConnectorOAuth?.().then(async (result) => {
      if (!result) return;
      const response = await completeConnectorOAuth(result).catch(() => undefined);

      oauthError = response?.failure;

      if (response?.account && !response.error) {
        if (response.slackMessaging) {
          notice = "slack-bot-authorized";
          window.dispatchEvent(new Event("messenger-accounts-changed"));
        } else update(response.account, response.alreadyConnected);
        oauthCompletion = response;
      } else notice = "error";
    });
  });

  function refreshAccounts() {
    if (document.visibilityState === "visible") void route.refresh("app:connectors");
  }

  async function reload() {
    if (reloading) {
      reloadAgain = true;

      return;
    }

    reloading = true;

    try {
      const result = await listConnectors();

      const completed = result.accounts.find(
        (next) =>
          next.status === "connected" &&
          accounts.some((previous) => previous.id === next.id && previous.status === "needs_reconnect"),
      );

      if (completed) oauthCompletion = create(connectors.CompleteConnectorOAuthResponseSchema, { account: completed });
      catalog = result;
      accounts = result.accounts;
    } finally {
      reloading = false;

      if (reloadAgain) {
        reloadAgain = false;
        void reload().catch(() => {});
      }
    }
  }

  // Accounts, grants and OAuth results from any client arrive as `connectorsChanged`. A gateway that does not
  // push them (older) gets one visible-page check every 30 s instead.
  onMount(() =>
    overview.subscribe((update) => {
      if (update.change.case === "connectorsChanged") void reload().catch(() => {});
    }),
  );

  onMount(() => {
    const timer = setInterval(() => {
      if (!document.hidden && !overview.pushed.has("connectors")) void reload().catch(() => {});
    }, CONNECTORS_FALLBACK_MS);

    return () => clearInterval(timer);
  });

  function update(account: connectors.ConnectorAccount, alreadyConnected?: boolean) {
    notice = null;

    if (alreadyConnected !== undefined) notice = alreadyConnected ? "already-connected" : "connected";
    accounts = accounts.some((a) => a.id === account.id)
      ? accounts.map((a) => (a.id === account.id ? account : a))
      : [...accounts, account];
    window.dispatchEvent(new Event("connectors-changed"));
  }

  function remove(id: string) {
    notice = null;
    accounts = accounts.filter((a) => a.id !== id);
    window.dispatchEvent(new Event("connectors-changed"));
  }
</script>

<svelte:window onfocus={refreshAccounts} />
<svelte:document onvisibilitychange={refreshAccounts} />

<div class="settings-stack">
  <SettingsHeading title="Connectors" description="Connect your apps and choose who can use each account." />
  <ConfigNotices match={(n) => n.kind === "connector" || n.kind === "oauth_app"} onchange={() => void reload()} />
  {#if settings.moduleEnabled("bots") && botList.error}
    <Alert tone="error"
      >Could not load bots for account access.
      {#snippet actions()}<Button size="sm" onclick={() => void botList.refresh()}>Retry</Button>{/snippet}
    </Alert>
  {/if}
  {#each unavailable as computer (computer.nodeId)}
    <Alert>
      {computer.unavailableReason}{computer.unavailableReason.endsWith(".") ? "" : "."} Its bot list may be incomplete.
    </Alert>
  {/each}
  {#each refreshing as computer (computer.nodeId)}
    <Alert>{computer.unavailableReason}</Alert>
  {/each}
  {#if notice === "slack-bot-authorized"}<Alert>Slack Bot authorized.</Alert
    >{:else if notice === "already-connected"}<Alert>Already connected.</Alert>{:else if notice === "connected"}<Alert
      >Account connected. Manage access from the account menu.</Alert
    >{:else if notice === "error" && oauthError}<ConnectionError
      error={oauthError}
    />{:else if notice === "error"}<Alert tone="error"
      >Sign-in could not finish. Reconnect the account to try again.</Alert
    >{/if}
  <section aria-label="Connect an app" class="grid gap-4">
    <h2 class="text-lg font-semibold text-balance">Add an account</h2>
    <div class="flex flex-wrap gap-2">
      {#each catalog.types as entry (entry.id)}
        <Button
          size="sm"
          onclick={() => {
            selected = entry.id;
            connecting = true;
          }}
          class="max-w-full"
          ><ConnectorIcon type={entry.id} class="shrink-0" /><span class="min-w-0 truncate">{entry.name}</span></Button
        >
        {#if entry.id === "slack" && settings.moduleEnabled("bots")}
          <Button size="sm" disabled={!slackBotReady} onclick={() => (addingSlackBot = true)}>
            <ConnectorIcon type="slack" />
            Slack Bot
          </Button>
        {/if}
      {/each}
    </div>
  </section>
  <section aria-label="Tool accounts" class="grid gap-4">
    <h2 class="text-lg font-semibold text-balance">Tool accounts</h2>
    {#if accounts.length}<InsetList label="Tool accounts">
        {#each accounts as account (account.id)}
          {@const entry = catalog.types.find((t) => t.id === account.connectorType)}
          {#if entry}<li>
              <AccountDetail
                {account}
                type={entry}
                {projects}
                projectsLoaded={overview.resyncs > 0}
                {bots}
                {oauthCompletion}
                onupdate={update}
                onremove={remove}
              />
            </li>{/if}
        {/each}
      </InsetList>{:else}<p class="py-4 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        No accounts connected yet.
      </p>{/if}
  </section>
  {#if settings.moduleEnabled("bots")}
    <SlackBotConnections
      slackUsers={accounts.filter((account) => account.connectorType === "slack")}
      {oauthCompletion}
      bind:adding={addingSlackBot}
      bind:ready={slackBotReady}
    />
  {/if}
</div>
{#if connecting && type}<ConnectAccountDialog bind:open={connecting} {type} {oauthCompletion} onsave={update} />{/if}

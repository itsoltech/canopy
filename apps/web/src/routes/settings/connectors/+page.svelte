<script lang="ts">
  import { botList } from "#lib/features/bots/bot-list.svelte.ts";
  import { onMount, untrack } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { bots as botContract, connectors } from "@canopy/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettingsRoute } from "#lib/features/settings/settings-route.ts";
  import SettingsHeading from "#lib/features/settings/SettingsHeading.svelte";
  import ConnectorIcon from "#lib/features/connectors/ConnectorIcon.svelte";
  import ConnectAccountDialog from "#lib/features/connectors/ConnectAccountDialog.svelte";
  import AccountDetail from "#lib/features/connectors/AccountDetail.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { decode } from "#lib/shared/wire.ts";
  import { completeConnectorOAuth, listConnectors } from "#lib/features/connectors/api.ts";
  import type { PageProps } from "./$types";
  import ConfigNotices from "#lib/features/computers/ConfigNotices.svelte";
  import ConnectionError from "#lib/features/connectors/ConnectionError.svelte";
  import { workerRecords } from "#lib/features/workers/worker-records.svelte.ts";

  let { data }: PageProps = $props();
  const overview = useOverview();
  const records = workerRecords(overview);

  const workers = $derived(
    records.workers.map((w) => ({ id: w.id, name: w.name, group: records.name(w), readOnly: records.readOnly(w.id) })),
  );

  const route = useSettingsRoute();
  let catalog = $state(untrack(() => decode(connectors.ListConnectorsResponseSchema, data.connections)));

  let accounts = $state<connectors.ConnectorAccount[]>(
    untrack(() => decode(connectors.ListConnectorsResponseSchema, data.connections).accounts),
  );

  let botCatalog = $state(untrack(() => decode(botContract.ListBotsResponseSchema, data.bots)));
  let reloading = false;
  let reloadAgain = false;
  const CONNECTORS_FALLBACK_MS = 30_000;

  // The shared bot list follows pushed changes; the route's list covers the first paint.
  $effect(() => botList.use());

  const bots = $derived(
    (botList.loaded ? botList.list.filter((b) => !b.archived) : botCatalog.bots).map((b) => ({
      id: b.id,
      name: b.configuration?.name ?? "Bot",
    })),
  );

  const unavailable = $derived(botCatalog.unavailableComputers);
  const refreshing = $derived(botCatalog.refreshingComputers);

  let selected = $state("");
  let connecting = $state(false);
  let oauthCompletion = $state<connectors.CompleteConnectorOAuthResponse>();
  let oauthError = $state<connectors.ConnectorError>();
  let notice = $state(untrack(() => route.url.searchParams.get("connection")));
  const type = $derived(catalog.types.find((t) => t.id === selected));

  $effect(() => {
    const next = decode(connectors.ListConnectorsResponseSchema, data.connections);
    catalog = next;
    accounts = next.accounts;
    botCatalog = decode(botContract.ListBotsResponseSchema, data.bots);
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
        update(response.account, response.alreadyConnected);
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
  <SettingsHeading
    title="Connectors"
    description="Connect your apps once. Choose which workers and bots can use each account."
  />
  <ConfigNotices match={(n) => n.kind === "connector" || n.kind === "oauth_app"} onchange={() => void reload()} />
  {#each unavailable as computer (computer.nodeId)}
    <Alert>
      {computer.unavailableReason}{computer.unavailableReason.endsWith(".") ? "" : "."} Its bot list may be incomplete.
    </Alert>
  {/each}
  {#each refreshing as computer (computer.nodeId)}
    <Alert>{computer.unavailableReason}</Alert>
  {/each}
  {#if notice === "already-connected"}<Alert>Already connected.</Alert>{:else if notice === "connected"}<Alert
      >Account connected. Choose who can use it below.</Alert
    >{:else if notice === "error" && oauthError}<ConnectionError
      error={oauthError}
    />{:else if notice === "error"}<Alert tone="error"
      >Sign-in could not finish. Reconnect the account to try again.</Alert
    >{/if}
  <section aria-label="Connect an app" class="grid gap-4">
    <h2 class="text-lg font-semibold text-balance">Add an account</h2>
    <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {#each catalog.types as entry (entry.id)}
        <button
          type="button"
          onclick={() => {
            selected = entry.id;
            connecting = true;
          }}
          class="relative flex min-h-(--settings-target) min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-base/5 ring-1 ring-zinc-950/10 focus-ring hover:bg-zinc-950/4 sm:text-sm/5 dark:ring-white/10 dark:hover:bg-white/5"
          ><ConnectorIcon type={entry.id} class="shrink-0" /><span class="min-w-0 text-pretty">{entry.name}</span
          ></button
        >
      {/each}
    </div>
  </section>
  <section aria-label="Connected accounts" class="grid gap-4">
    <h2 class="text-lg font-semibold text-balance">Your accounts</h2>
    {#each accounts as account (account.id)}
      {@const entry = catalog.types.find((t) => t.id === account.connectorType)}
      {#if entry}<div>
          <AccountDetail
            {account}
            type={entry}
            {workers}
            {bots}
            {oauthCompletion}
            onupdate={update}
            onremove={remove}
          />
        </div>{/if}
    {:else}<p class="py-4 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        No accounts connected yet. Pick an app above to connect one.
      </p>{/each}
  </section>
</div>
{#if connecting && type}<ConnectAccountDialog bind:open={connecting} {type} {oauthCompletion} onsave={update} />{/if}

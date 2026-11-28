<script lang="ts">
  import { onMount } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { connectors, type github } from "@canopy/contracts";
  import {
    eligibleSourceAccounts,
    sourceGitHubAccount,
    sourceGitHubRepository,
    sourceUrl,
    type SourceKind,
  } from "@canopy/domain/source-access";
  import { accounts as listGitHubAccounts } from "#lib/features/github/api.ts";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import Field from "#lib/shared/ui/Field.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";

  let {
    command,
    kind,
    accountId = $bindable(""),
    disabled = false,
    onchange,
    class: className,
  }: {
    command: string;
    kind: SourceKind;
    accountId?: string;
    disabled?: boolean;
    onchange: () => void;
    class?: ClassValue;
  } = $props();

  let accounts = $state.raw<connectors.ConnectorAccount[]>();
  let githubAccounts = $state.raw<github.GitHubAccount[]>();
  let connectorError = $state(false);
  let githubError = $state(false);
  let githubRequested = false;
  const repository = $derived(sourceGitHubRepository(sourceUrl(command, kind)));
  const eligible = $derived(eligibleSourceAccounts(command, kind, accounts ?? [], githubAccounts ?? []));

  $effect(() => {
    const loaded = sourceGitHubAccount(accountId) ? !repository || githubAccounts : accounts;

    if (loaded && accountId && !eligible.some((item) => item.id === accountId)) {
      accountId = "";
      onchange();
    }
  });

  $effect(() => {
    if (!repository || githubRequested) return;
    githubRequested = true;
    void listGitHubAccounts("")
      .then((response) => (githubAccounts = response.accounts))
      .catch(() => {
        githubAccounts = [];
        githubError = true;
      });
  });

  onMount(() => {
    void requestJson("GET", "/api/connectors")
      .then((data) => (accounts = decode(connectors.ListConnectorsResponseSchema, data).accounts))
      .catch(() => {
        accounts = [];
        connectorError = true;
      });
  });
</script>

{#if eligible.length}
  <Field label="Source access" description="Choose an account for a private repository." class={className}>
    <Select
      class="min-w-0"
      name="skill-source-account"
      value={accountId}
      {disabled}
      options={[
        { value: "", label: kind === "skill" ? "Public source" : "Public repository · no credentials" },
        ...eligible.map((a) => ({ value: a.id, label: a.label })),
      ]}
      onchange={(id) => {
        accountId = id;
        onchange();
      }}
    />
  </Field>
{/if}
{#if connectorError || (repository && githubError)}
  <Alert tone="warning" class={className}
    >Couldn’t load all source accounts. Check the connection and reopen this panel.</Alert
  >
{/if}

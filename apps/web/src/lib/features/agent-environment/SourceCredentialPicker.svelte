<script lang="ts">
  import { onMount } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { connectors } from "@canopy/contracts";
  import { eligibleSourceAccounts, type SourceKind } from "@canopy/domain/source-access";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import Field from "#lib/shared/ui/Field.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";

  let {
    command,
    kind,
    account = $bindable(),
    disabled = false,
    onchange,
    class: className,
  }: {
    command: string;
    kind: SourceKind;
    account?: connectors.ConnectorAccount | undefined;
    disabled?: boolean;
    onchange: () => void;
    class?: ClassValue;
  } = $props();

  let accounts = $state.raw<connectors.ConnectorAccount[]>();
  let error = $state("");
  const eligible = $derived(eligibleSourceAccounts(command, kind, accounts ?? (account ? [account] : [])));

  $effect(() => {
    if (account && !eligible.some((item) => item.id === account?.id)) {
      account = undefined;
      onchange();
    }
  });

  onMount(() => {
    void requestJson("GET", "/api/connectors")
      .then((data) => {
        accounts = decode(connectors.ListConnectorsResponseSchema, data).accounts;
      })
      .catch(() => {
        accounts = [];
        error = "Couldn't load connector accounts. Open Settings → Connectors to check access.";
      });
  });
</script>

{#if eligible.length}
  <Field label="Source access" description="Choose an account for a private repository." class={className}>
    <Select
      class="min-w-0"
      name="skill-source-account"
      value={account?.id ?? ""}
      {disabled}
      options={[
        { value: "", label: "Public repository · no credentials" },
        ...eligible.map((a) => ({ value: a.id, label: `${a.name} · ${new URL(a.url).host}` })),
      ]}
      onchange={(id) => {
        account = eligible.find((item) => item.id === id);
        onchange();
      }}
    />
  </Field>
{:else if error}
  <Alert tone="warning" class={className}>{error}</Alert>
{/if}

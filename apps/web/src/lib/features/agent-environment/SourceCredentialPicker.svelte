<script lang="ts">
  import { onMount } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { connectors } from "@canopy/contracts";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import Field from "#lib/shared/ui/Field.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";

  let {
    value = $bindable(""),
    disabled = false,
    onchange,
    class: className,
  }: { value?: string; disabled?: boolean; onchange: () => void; class?: ClassValue } = $props();

  let accounts = $state<connectors.ConnectorAccount[]>([]);
  let error = $state("");

  onMount(() => {
    void requestJson("GET", "/api/connectors")
      .then((data) => {
        accounts = decode(connectors.ListConnectorsResponseSchema, data).accounts.filter(
          (a) => a.status === "connected",
        );
      })
      .catch(() => {
        error = "Couldn't load connector accounts. Open Settings → Connectors to check access.";
      });
  });
</script>

<div class={["grid min-w-0 gap-2", className]}>
  <Field
    label="Source access"
    description="For private repositories, choose a GitHub account or a connected account for the same host. Credentials stay in the gateway. Manage accounts in Settings → Connectors."
  >
    <Select
      name="skill-source-account"
      bind:value
      {disabled}
      options={[
        { value: "", label: "Public repository · no credentials" },
        ...accounts.map((a) => ({ value: a.id, label: `${a.name} · ${new URL(a.url).hostname}` })),
      ]}
      {onchange}
    />
  </Field>
  {#if error}<Alert tone="warning">{error}</Alert>{/if}
</div>

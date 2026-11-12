<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import ThreadSyncDiagnostics from "#lib/features/settings/ThreadSyncDiagnostics.svelte";
  import { diagnosticsRanges, diagnosticsSorts, diagnosticsKinds } from "@canopy/domain/diagnostics";
  import { diagnosticsRead, diagnosticsOverview } from "#lib/features/diagnostics/read.ts";
  import { revalidateEvery } from "#lib/shared/queries.svelte.ts";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import ComputerHealth from "#lib/features/diagnostics/ComputerHealth.svelte";
  import Findings from "#lib/features/diagnostics/Findings.svelte";
  import Calls from "#lib/features/diagnostics/Calls.svelte";
  import Grants from "#lib/features/diagnostics/Grants.svelte";
  import GatewayMetrics from "#lib/features/diagnostics/GatewayMetrics.svelte";
  import LinkMetrics from "#lib/features/diagnostics/LinkMetrics.svelte";
  import ClientMetrics from "#lib/features/diagnostics/ClientMetrics.svelte";
  import ReportActions from "#lib/features/diagnostics/ReportActions.svelte";

  let range = $state("15");
  let computer = $state("");
  let offset = $state(0);
  let sort = $state("p95");
  let kind = $state("unary");
  const key = $derived(`GetDiagnostics:${range}`);
  const overview = $derived(diagnosticsOverview(key, range));
  const selected = $derived(computer || overview.data?.computers[0]?.computerId || "");
  const detailsKey = $derived(`GetComputerDiagnostics:${selected}:${range}:${offset}:${sort}:${kind}`);

  const detail = $derived(diagnosticsRead(detailsKey, selected, range, offset, sort, kind));

  $effect(() => revalidateEvery(key, overview.snapshot.error ? 30_000 : 5000));

  $effect(() => (selected ? revalidateEvery(detailsKey, detail.snapshot.error ? 30_000 : 10_000) : undefined));

  function select(value: string) {
    computer = value;
    offset = 0;
  }
</script>

<svelte:head><title>Diagnostics · Settings · {applicationName}</title></svelte:head>
<div class="grid min-w-0 grid-cols-1 gap-6">
  <SettingsGroup title="Diagnostics" description="Check performance across your computers." cards>
    {#snippet actions()}<div class="w-28">
        <Select
          aria-label="Time range"
          value={range}
          options={diagnosticsRanges}
          onchange={(value) => {
            range = value;
            offset = 0;
          }}
        />
      </div>{/snippet}
    {#if overview.snapshot.error || (selected && detail.snapshot.error)}
      <Alert tone="error"
        >Could not refresh diagnostics. Retry to get the latest data.
        {#snippet actions()}<Button
            onclick={() => {
              void overview.reload();
              if (selected) void detail.reload();
            }}>Retry</Button
          >{/snippet}
      </Alert>
    {/if}
    {#if !overview.data && !overview.snapshot.error}
      <div class="grid gap-3" aria-busy="true" aria-label="Loading diagnostics">
        <Skeleton class="h-36" />
        <Skeleton class="h-36" />
      </div>
    {/if}
    {#if overview.data}
      <div class="grid min-w-0 grid-cols-1 gap-3 xl:grid-cols-2">
        {#each overview.data.computers as item (item.computerId)}<ComputerHealth
            computer={item}
            selected={selected === item.computerId}
            onselect={() => select(item.computerId)}
          />{/each}
      </div>
    {/if}
  </SettingsGroup>
  {#if overview.data}
    <Findings computers={overview.data.computers} />
    <ReportActions
      computers={overview.data.computers}
      range={Number(range)}
      computer={detail.data?.computerId === selected ? detail.data : undefined}
      onreset={() => {
        void overview.reload();
        void detail.reload();
      }}
    />
    <div class="max-w-sm">
      <Select
        aria-label="Computer"
        value={selected}
        options={overview.data.computers.map((item) => ({ value: item.computerId, label: item.name }))}
        onchange={select}
      />
    </div>
    <div class="grid grid-cols-2 gap-3">
      <Select
        aria-label="Sort calls"
        value={sort}
        options={diagnosticsSorts}
        onchange={(value) => {
          sort = value;
          offset = 0;
        }}
      />
      <Select
        aria-label="Call type"
        value={kind}
        options={diagnosticsKinds}
        onchange={(value) => {
          kind = value;
          offset = 0;
        }}
      />
    </div>
  {/if}
  {#if selected && detail.data?.computerId === selected}
    <GatewayMetrics computer={detail.data} />
    <LinkMetrics computer={detail.data} />
    <ClientMetrics computer={detail.data} />
    <Calls
      computer={detail.data}
      {offset}
      next={() => (offset = detail.data?.nextOffset ?? 0)}
      previous={() => (offset = Math.max(0, offset - 32))}
    />
  {/if}
  <ThreadSyncDiagnostics />
  <Grants />
</div>

<script lang="ts">
  import SettingsTopics from "#lib/features/settings/SettingsTopics.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import ResetCounters from "#lib/features/diagnostics/ResetCounters.svelte";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import Tracing from "#lib/features/diagnostics/Tracing.svelte";
  import { applicationName } from "#lib/application-name.ts";
  import ThreadSyncDiagnostics from "#lib/features/settings/ThreadSyncDiagnostics.svelte";
  import {
    diagnosticsRanges,
    diagnosticsSorts,
    diagnosticsKinds,
    diagnosticsUnavailable,
  } from "@canopy/domain/diagnostics";
  import { diagnosticsRead, diagnosticsOverview } from "#lib/features/diagnostics/read.ts";
  import { revalidateEvery } from "#lib/shared/queries.svelte.ts";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import ComputerHealth from "#lib/features/diagnostics/ComputerHealth.svelte";
  import Findings from "#lib/features/diagnostics/Findings.svelte";
  import Storage from "#lib/features/diagnostics/Storage.svelte";
  import Calls from "#lib/features/diagnostics/Calls.svelte";
  import Grants from "#lib/features/diagnostics/Grants.svelte";
  import GatewayMetrics from "#lib/features/diagnostics/GatewayMetrics.svelte";
  import LinkMetrics from "#lib/features/diagnostics/LinkMetrics.svelte";
  import ClientMetrics from "#lib/features/diagnostics/ClientMetrics.svelte";
  import ReportActions from "#lib/features/diagnostics/ReportActions.svelte";
  import CollectLogs from "#lib/features/diagnostics/CollectLogs.svelte";

  let topicPicker: ReturnType<typeof SettingsTopics>;
  const settings = useSettings();
  let range = $state("15");
  let logsJobId = $state("");
  let computer = $state("");
  let offset = $state(0);
  let sort = $state("p95");
  let kind = $state("unary");
  const key = $derived(`GetDiagnostics:${range}`);
  const overview = $derived(diagnosticsOverview(key, range));
  const computers = $derived(overview.data?.computers ?? []);

  const selected = $derived(
    computers.find((item) => item.computerId === computer)?.computerId ?? computers[0]?.computerId ?? "",
  );

  const computerOptions = $derived(computers.map((item) => ({ value: item.computerId, label: item.name })));
  const detailsKey = $derived(`GetComputerDiagnostics:${selected}:${range}:${offset}:${sort}:${kind}`);

  const detail = $derived(diagnosticsRead(detailsKey, selected, range, offset, sort, kind));

  const current = $derived(selected && detail.data?.computerId === selected ? detail.data : undefined);

  $effect(() => revalidateEvery(key, overview.snapshot.error ? 30_000 : 5000));

  $effect(() => (selected ? revalidateEvery(detailsKey, detail.snapshot.error ? 30_000 : 10_000) : undefined));

  function select(value: string) {
    computer = value;
    offset = 0;
  }

  function refresh() {
    void overview.reload();

    if (selected) void detail.reload();
  }
</script>

<svelte:head><title>Diagnostics · Settings · {applicationName}</title></svelte:head>

<SettingsTopics
  bind:this={topicPicker}
  label="Diagnostics settings"
  topics={[
    { id: "overview", label: "Overview", content: summary },
    { id: "performance", label: "Performance", content: performance },
    { id: "calls-and-tracing", label: "Calls and tracing", content: calls },
    { id: "reports-and-logs", label: "Reports and logs", content: reports },
  ]}
/>

{#snippet rangeControl()}
  <Field label="Time range" class="w-28">
    <Select
      value={range}
      options={diagnosticsRanges}
      onchange={(value) => {
        range = value;
        offset = 0;
      }}
    />
  </Field>
{/snippet}

{#snippet scope()}
  <div class="flex flex-wrap items-end gap-3">
    <Field label="Computer" class="w-64 max-w-full">
      <Select value={selected} options={computerOptions} onchange={select} disabled={!computerOptions.length} />
    </Field>
    {@render rangeControl()}
  </div>
{/snippet}

{#snippet readStatus(withDetails: boolean)}
  {#if overview.snapshot.error || (withDetails && selected && detail.snapshot.error)}
    <Alert tone="error">
      Could not refresh diagnostics.
      {#snippet actions()}<Button onclick={refresh}>Retry</Button>{/snippet}
    </Alert>
  {/if}
  {#if (!overview.data && !overview.snapshot.error) || (withDetails && selected && !current && !detail.snapshot.error)}
    <div class="grid gap-3" aria-busy="true" aria-label="Loading diagnostics">
      <Skeleton class="h-36" />
      <Skeleton class="h-36" />
    </div>
  {:else if overview.data && !computers.length}
    <p class="px-1 text-sm text-muted">No computers are reporting diagnostics.</p>
  {/if}
{/snippet}

{#snippet summary()}
  <SettingsGroup title="Computer health" cards>
    {#snippet actions()}{@render rangeControl()}{/snippet}
    {@render readStatus(false)}
    {#if computers.length}
      <div class="grid min-w-0 grid-cols-1 gap-3 @min-[40rem]/settings-content:grid-cols-2">
        {#each computers as item (item.computerId)}
          <ComputerHealth
            computer={item}
            onselect={() => {
              select(item.computerId);
              topicPicker.selectTopic("performance");
            }}
          />
        {/each}
      </div>
    {/if}
  </SettingsGroup>
  {#if overview.data}
    <Findings {computers} />
    <Storage snapshot={overview.data} />
  {/if}
  {#if settings.moduleEnabled("threads")}<ThreadSyncDiagnostics />{/if}
{/snippet}

{#snippet performance()}
  {@render scope()}
  {@render readStatus(true)}
  {#if current}
    {#if current.detailsAvailable}
      <GatewayMetrics computer={current} />
      <LinkMetrics computer={current} />
      <ClientMetrics computer={current} />
    {:else}
      {@const [title, description] = diagnosticsUnavailable(current)}
      <Alert {title}>{description}</Alert>
    {/if}
    {#key selected}
      <ResetCounters computer={current} localComputerId={computers[0]?.computerId} onreset={refresh} />
    {/key}
  {/if}
{/snippet}

{#snippet calls()}
  {@render scope()}
  {@render readStatus(true)}
  <div class="grid max-w-xl grid-cols-2 gap-3">
    <Field label="Sort calls">
      <Select
        value={sort}
        disabled={!selected}
        options={diagnosticsSorts}
        onchange={(value) => {
          sort = value;
          offset = 0;
        }}
      />
    </Field>
    <Field label="Call type">
      <Select
        value={kind}
        disabled={!selected}
        options={diagnosticsKinds}
        onchange={(value) => {
          kind = value;
          offset = 0;
        }}
      />
    </Field>
  </div>
  {#if current}
    {#key selected}
      <Calls
        computer={current}
        {offset}
        next={() => (offset = current?.nextOffset ?? 0)}
        previous={() => (offset = Math.max(0, offset - 32))}
      />
      <Tracing computer={current} onrefresh={refresh} />
    {/key}
  {/if}
{/snippet}

{#snippet reports()}
  {@render readStatus(false)}
  <ReportActions {logsJobId} {computers} range={Number(range)} {rangeControl} />
  <CollectLogs {computers} onready={(id) => (logsJobId = id)} />
  <Grants />
{/snippet}

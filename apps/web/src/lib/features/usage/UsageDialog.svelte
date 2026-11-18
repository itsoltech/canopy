<script lang="ts">
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import UsageTotals from "./UsageTotals.svelte";
  import UsageChart from "./UsageChart.svelte";
  import UsageBreakdown from "./UsageBreakdown.svelte";
  import UsageSources from "./UsageSources.svelte";
  import UsageProviderMark from "./UsageProviderMark.svelte";
  import SpeedIcon from "#lib/features/models/SpeedIcon.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { loadUsage } from "./api.ts";
  import type { UsageData, UsageView } from "./format.ts";
  import "#lib/features/settings/density.css";

  let { open = $bindable(false) }: { open?: boolean } = $props();
  let view = $state("cost");
  let days = $state("30");
  let provider = $state("");
  let computerId = $state("");
  let speed = $state("");
  let revision = $state(0);
  let data = $state.raw<UsageData>();
  let computers = $state<UsageData["computers"]>([]);
  let speeds = $state<UsageData["speeds"]>([]);
  let loading = $state(false);
  let failed = $state(false);
  const selectedView = $derived<UsageView>(view === "tokens" ? "tokens" : "cost");

  const computerOptions = $derived([
    { value: "", label: "All computers" },
    ...computers.map((computer) => ({ value: computer.id, label: computer.name })),
  ]);

  const speedOptions = $derived([
    { value: "", label: "All speeds" },
    ...speeds.map((row) => ({ value: `tier:${row.key}`, label: row.label })),
  ]);

  $effect(() => {
    if (!open) return;
    const controller = new AbortController();
    const selectedComputer = computerId;
    const selectedSpeed = speed;
    void revision;
    data = undefined;
    loading = true;
    failed = false;
    void loadUsage(
      days,
      provider,
      selectedComputer,
      selectedSpeed ? selectedSpeed.slice(5) : undefined,
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        data = result;

        if (!selectedComputer) computers = result.computers;

        if (!selectedSpeed) speeds = result.speeds;
      })
      .catch(() => {
        if (!controller.signal.aborted) failed = true;
      })
      .finally(() => {
        if (!controller.signal.aborted) loading = false;
      });

    return () => controller.abort();
  });
</script>

<Dialog bind:open title="Usage" bare fullscreen size="output" class="settings-density h-[min(90dvh,55rem)]">
  <div class="flex h-full min-h-0 flex-col">
    <header
      class="flex shrink-0 items-center gap-3 border-b border-divider bg-surface py-2 pr-3 pl-5 sm:pl-6"
      data-window-drag
    >
      <h2 class="min-w-0 flex-1 text-lg/7 font-semibold">Usage</h2>
      <IconButton icon="arrow-path" label="Refresh usage" disabled={loading} onclick={() => revision++} />
      <IconButton icon="x-mark" label="Close usage" data-autofocus onclick={() => (open = false)} />
    </header>
    <div class="min-h-0 flex-1 scroll-stable overflow-y-auto overscroll-contain">
      <div class="grid min-w-0 gap-5 p-5 pb-[max(--spacing(5),env(safe-area-inset-bottom))] sm:p-6">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <SegmentedChoice
            label="Usage view"
            bind:value={view}
            options={[
              { value: "cost", label: "Cost" },
              { value: "tokens", label: "Tokens" },
            ]}
          />
          <SegmentedChoice
            label="Time period"
            bind:value={days}
            options={[
              { value: "1", label: "Today" },
              { value: "7", label: "7 days" },
              { value: "30", label: "30 days" },
              { value: "90", label: "90 days" },
            ]}
          />
        </div>
        <div class="grid min-w-0 grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:grid-cols-3">
          <Field label="Provider">
            <Select
              bind:value={provider}
              options={[
                { value: "", label: "All providers" },
                { value: "claude", label: "Claude" },
                { value: "codex", label: "Codex" },
                { value: "grok", label: "Grok" },
              ]}
            >
              {#snippet leading(option)}
                {#if option.value}<UsageProviderMark provider={option.value} />{:else}<Icon name="table-cells" />{/if}
              {/snippet}
            </Select>
          </Field>
          <Field label="Computer"><Select bind:value={computerId} options={computerOptions} /></Field>
          <div class="min-[360px]:col-span-2 sm:col-span-1">
            <Field label="Requested speed">
              <Select bind:value={speed} options={speedOptions}>
                {#snippet leading(option)}
                  {#if option.value.slice(5)}
                    <SpeedIcon tier={option.value.slice(5)} />
                  {:else}
                    <span class="inline-flex h-3.5 w-6 shrink-0" aria-hidden="true"></span>
                  {/if}
                {/snippet}
              </Select>
            </Field>
          </div>
        </div>
        <p class="-mt-3 text-xs/5 text-zinc-500 dark:text-zinc-400">
          Requested speed may differ from the speed served by the provider.
        </p>
        {#if loading}
          <p
            role="status"
            class="flex items-center justify-center gap-2 py-20 text-sm/6 text-zinc-500 dark:text-zinc-400"
          >
            <Spinner />Loading usage…
          </p>
        {:else if failed}
          <Alert tone="error" title="Could not load usage">
            Check your connection, then try again.
            {#snippet actions()}<Button size="sm" onclick={() => revision++}>Try again</Button>{/snippet}
          </Alert>
        {:else if data}
          {#if data.computers.some((computer) => computer.status !== "ready" && (!computerId || computer.id === computerId))}
            <Alert tone="info">Some computers have incomplete usage. Open Recording coverage for details.</Alert>
          {/if}
          {#if data.totals.reports === 0n}
            <div class="py-12 text-center">
              <h3 class="text-base/6 font-medium sm:text-sm/6">No usage recorded</h3>
              <p class="mx-auto mt-2 max-w-sm text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">
                Try a different period or filter. New activity appears when an agent reports usage.
              </p>
            </div>
          {:else}
            <UsageTotals totals={data.totals} view={selectedView} />
            <UsageChart days={data.days} providers={data.providers} totals={data.totals} view={selectedView} />
            <UsageBreakdown {data} view={selectedView} />
          {/if}
          <UsageSources computers={data.computers} />
        {/if}
      </div>
    </div>
  </div>
</Dialog>

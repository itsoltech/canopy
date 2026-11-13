<script lang="ts">
  import { onDestroy } from "svelte";
  import { create, toJson } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import { diagnosticsLogRanges, diagnosticsLogStatus, diagnosticsLogBytes } from "@canopy/domain/diagnostics";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";

  let { computers, onready }: { computers: ui.ComputerDiagnostics[]; onready(id: string): void } = $props();
  let open = $state(false);
  let ids = $state<string[]>([]);
  let hours = $state("1");
  let legacy = $state(false);
  let job = $state<ui.DiagnosticsLogsJob>();
  let busy = $state(false);
  let error = $state("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;

  onDestroy(() => {
    alive = false;
    clearTimeout(timer);
  });

  const ready = $derived(job && ["done", "partial"].includes(job.status));

  async function poll() {
    if (!job || !alive) return;
    error = "";

    try {
      job = decode(ui.DiagnosticsLogsJobSchema, await requestJson("GET", `/api/diagnostics/logs/${job.jobId}`));

      if (["done", "partial"].includes(job.status)) onready(job.jobId);

      if (job.status === "collecting") timer = setTimeout(() => void poll(), 1000);
    } catch {
      error = "Could not refresh the collection. Retry to check its progress.";
    }
  }

  async function collect(selection = ids) {
    if (busy || !selection.length) return;
    busy = true;
    error = "";
    onready("");
    clearTimeout(timer);

    try {
      job = decode(
        ui.DiagnosticsLogsJobSchema,
        await requestJson(
          "POST",
          "/api/diagnostics/logs",
          toJson(
            ui.CollectDiagnosticsLogsRequestSchema,
            create(ui.CollectDiagnosticsLogsRequestSchema, {
              computerIds: selection,
              hours: Number(hours),
              includeLegacy: legacy,
              aliasHome: true,
              actionId: crypto.randomUUID(),
            }),
          ),
        ),
      );
      timer = setTimeout(() => void poll(), 500);
    } catch {
      error = "Could not collect logs. Check the selection and retry.";
    } finally {
      busy = false;
    }
  }

  async function cancel() {
    if (!job) return;
    busy = true;

    try {
      job = decode(ui.DiagnosticsLogsJobSchema, await requestJson("DELETE", `/api/diagnostics/logs/${job.jobId}`, {}));
      onready("");
    } catch {
      error = "Could not cancel the collection. Retry to check its progress.";
    } finally {
      busy = false;
      clearTimeout(timer);
    }
  }
</script>

<SettingsGroup title="Logs" description="Collect redacted logs from selected computers.">
  <div class="flex flex-wrap items-center gap-3 p-4">
    <Button
      onclick={() => {
        ids = computers.slice(0, 16).map((c) => c.computerId);
        open = true;
      }}>Collect logs</Button
    >
    {#if job}<span class="text-sm text-muted" role="status"
        >{diagnosticsLogStatus(job.status)} · {diagnosticsLogBytes(job.bytes)}</span
      >{/if}
    {#if ready}<ButtonLink href={`/api/diagnostics/logs/${job!.jobId}/download`}>Download logs</ButtonLink>{/if}
  </div>
</SettingsGroup>

<Dialog bind:open title="Collect logs" description="Secrets, paths and computer names are removed before transfer.">
  <div class="grid min-w-0 gap-4">
    <Field label="Time range"
      ><Select
        value={hours}
        options={diagnosticsLogRanges}
        onchange={(value) => (hours = value)}
        disabled={job?.status === "collecting"}
      /></Field
    >
    <div class="grid gap-2">
      <p class="font-medium">Computers</p>
      {#each computers.slice(0, 16) as computer (computer.computerId)}
        <div class="flex min-w-0 items-start justify-between gap-3">
          <div class="min-w-0">
            <Checkbox
              name={`logs-${computer.computerId}`}
              label={computer.name}
              disabled={job?.status === "collecting"}
              bind:checked={
                () => ids.includes(computer.computerId),
                (checked) => {
                  ids = checked ? [...ids, computer.computerId] : ids.filter((id) => id !== computer.computerId);
                }
              }
            />
          </div>
          <span class="shrink-0 text-sm text-muted"
            >{computer.status === "online" ? "Connected" : diagnosticsLogStatus(computer.status)}</span
          >
        </div>
      {/each}
    </div>
    <div class="grid gap-2">
      <Checkbox
        name="logs-legacy"
        label="Include untimed records"
        bind:checked={legacy}
        disabled={job?.status === "collecting"}
      />
      <p class="text-sm text-muted">Unknown records are omitted. The archive lists missing and truncated sources.</p>
      {#if ids.length > 8}<p class="text-sm text-muted">
          More computers share the same archive budget. Select fewer for more logs per computer.
        </p>{/if}
    </div>
    {#if job}
      <div class="grid gap-2" aria-live="polite">
        {#each job.homes as home (home.computerId)}
          <div class="flex min-w-0 justify-between gap-3">
            <span class="min-w-0 truncate"
              >{computers.find((c) => c.computerId === home.computerId)?.name || home.alias}</span
            >
            <span class="shrink-0 text-sm text-muted tabular-nums"
              >{diagnosticsLogStatus(home.status)} · {diagnosticsLogBytes(home.bytes)}</span
            >
          </div>
        {/each}
      </div>
      <p class="text-sm text-muted">Available for 15 minutes. Downloads stay on your device.</p>
      {#if job.status === "partial"}<Alert
          >Some sources are missing. Download the partial archive or retry failed computers.</Alert
        >{/if}
    {/if}
    {#if error}<Alert tone="error"
        >{error}{#snippet actions()}<Button onclick={() => void (job ? poll() : collect())}>Retry</Button
          >{/snippet}</Alert
      >{/if}
  </div>
  {#snippet footer()}
    <div class="flex flex-wrap justify-end gap-2">
      {#if job?.status === "collecting"}<Button loading={busy} onclick={cancel}>Cancel collection</Button>
      {:else}
        <Button onclick={() => (open = false)}>Close</Button>
        {#if ready}<ButtonLink href={`/api/diagnostics/logs/${job!.jobId}/download`}>Download logs</ButtonLink>{/if}
        {#if job?.status === "partial"}<Button
            loading={busy}
            onclick={() => collect(job!.homes.filter((home) => home.status !== "done").map((home) => home.computerId))}
            >Retry failed</Button
          >
        {:else}<Button variant="primary" loading={busy} disabled={!ids.length} onclick={() => collect()}
            >Collect logs</Button
          >{/if}
      {/if}
    </div>
  {/snippet}
</Dialog>

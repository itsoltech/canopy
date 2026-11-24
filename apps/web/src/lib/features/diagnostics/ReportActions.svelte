<script lang="ts">
  import type { Snippet } from "svelte";
  import { create, toJson } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Investigation from "./Investigation.svelte";

  let {
    computers,
    range,
    rangeControl,
    logsJobId = "",
  }: {
    computers: ui.ComputerDiagnostics[];
    range: number;
    rangeControl: Snippet;
    logsJobId?: string;
  } = $props();

  let open = $state(false);
  let ids = $state<string[]>([]);
  let format = $state("markdown");
  let report = $state<ui.DiagnosticsReport>();
  let busy = $state(false);
  let error = $state("");
  let message = $state("");

  async function preview() {
    if (busy || !ids.length) return;
    busy = true;
    error = "";

    try {
      report = decode(
        ui.DiagnosticsReportSchema,
        await requestJson(
          "POST",
          "/api/diagnostics/report",
          toJson(
            ui.DiagnosticsReportRequestSchema,
            create(ui.DiagnosticsReportRequestSchema, { computerIds: ids, windowMinutes: range, format }),
          ),
        ),
      );
    } catch {
      error = "Could not prepare the report. Check the connection and retry.";
    } finally {
      busy = false;
    }
  }

  async function copy() {
    if (!report) return;

    try {
      await navigator.clipboard.writeText(report.text);
      message = "Report copied.";
    } catch {
      error = "Could not copy the report. Select and copy the preview instead.";
    }
  }
</script>

<SettingsGroup title="Diagnostics report" description="Choose which computers to include in the report.">
  {#snippet actions()}{@render rangeControl()}{/snippet}
  <div class="grid min-w-0 gap-3 p-4">
    <div>
      <Button
        disabled={!computers.length}
        onclick={() => {
          ids = computers.slice(0, 16).map((item) => item.computerId);
          report = undefined;
          error = "";
          message = "";
          open = true;
        }}>Prepare report</Button
      >
    </div>
    {#if message}<p role="status" class="text-sm text-muted">{message}</p>{/if}
  </div>
</SettingsGroup>

<Dialog
  bind:open
  title="Diagnostics report"
  description={`Review ${range} minutes of observations before copying or sharing.`}
  size="lg"
  dismissible={!busy}
>
  <div class="grid min-w-0 gap-4">
    {#if !report}
      {#each computers as item (item.computerId)}
        <Checkbox
          name={item.computerId}
          label={item.name}
          description={item.status}
          disabled={ids.length >= 16 && !ids.includes(item.computerId)}
          bind:checked={
            () => ids.includes(item.computerId),
            (checked) => (ids = checked ? [...ids, item.computerId] : ids.filter((id) => id !== item.computerId))
          }
        />
      {/each}
      <Field label="Format"
        ><Select
          value={format}
          options={[
            { value: "markdown", label: "Markdown" },
            { value: "json", label: "JSON" },
          ]}
          onchange={(value) => (format = value)}
        /></Field
      >
      <div><Button loading={busy} disabled={!ids.length} onclick={preview}>Preview report</Button></div>
    {:else}
      <p class="text-sm text-muted">
        Names are replaced with aliases. This report contains measurements, sampling and coverage gaps.
      </p>
      {#if report.omittedSections.length}<Alert tone="warning">Omitted: {report.omittedSections.join("; ")}</Alert>{/if}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -- Keyboard access scrolls the bounded report preview. -->
      <div
        role="region"
        aria-label="Report preview"
        tabindex="0"
        class="max-h-64 min-w-0 overflow-auto rounded-lg border border-divider p-3"
      >
        <pre class="text-xs wrap-anywhere whitespace-pre-wrap">{report.text}</pre>
      </div>
      <div>
        <Button onclick={copy}>Copy report</Button><Button onclick={() => (report = undefined)}>Change selection</Button
        >
      </div>
      <Investigation {report} {logsJobId} />
    {/if}
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    {#if message}<p role="status" class="text-sm text-muted">{message}</p>{/if}
  </div>
</Dialog>

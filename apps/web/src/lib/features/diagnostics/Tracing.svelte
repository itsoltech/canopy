<script lang="ts">
  import { create, toJson, toJsonString } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";

  let { computer, onrefresh }: { computer: ui.ComputerDiagnostics; onrefresh(): void } = $props();
  let minutes = $state("5");
  let process = $state("gateway");
  let busy = $state(false);
  let error = $state("");
  let message = $state("");
  const traceState = $derived(computer.tracing);
  const connected = $derived(computer.status === "online" && computer.tracingSupported);

  const processes = $derived([
    { value: "gateway", label: "Gateway" },
    ...computer.links
      .filter((link) => link.kind === "worker" && link.online)
      .map((link) => ({ value: `worker:${link.targetId}`, label: link.name })),
  ]);

  async function action(kind: "start" | "stop" | "export") {
    if (busy) return;
    busy = true;
    error = message = "";
    const target = computer;

    try {
      const request = create(ui.DiagnosticsTraceRequestSchema, {
        computerId: target.computerId,
        processId: kind === "start" ? process : target.tracing?.processId,
        minutes: Number(minutes),
        action: kind === "export" ? "" : kind,
        leaseId: target.tracing?.leaseId,
      });

      const result = await requestJson(
        "POST",
        `/api/diagnostics/${kind === "export" ? "trace-export" : "trace"}`,
        toJson(ui.DiagnosticsTraceRequestSchema, request),
      );

      if (kind === "export") {
        const value = decode(ui.DiagnosticsTraceExportSchema, result);

        const url = URL.createObjectURL(
          new Blob([toJsonString(ui.DiagnosticsTraceExportSchema, value)], { type: "application/json" }),
        );

        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "canopy-trace.json";
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        message = `Exported ${value.spans.length} samples. ${value.droppedSamples} samples dropped at the limits.`;
      } else {
        const value = decode(ui.DiagnosticsTraceStateSchema, result);

        if (computer.computerId === target.computerId)
          computer = create(ui.ComputerDiagnosticsSchema, { ...computer, tracing: value });
        message = kind === "start" ? "Tracing started on the selected process." : "Tracing stopped.";
      }

      onrefresh();
    } catch {
      error = "Could not complete tracing. Refresh diagnostics and retry.";
    } finally {
      busy = false;
    }
  }
</script>

<SettingsGroup title="Deeper tracing">
  <div class="grid min-w-0 gap-3 p-4">
    <p class="text-sm text-muted">Samples up to 1% of operations on this computer. No messages, SQL or error text.</p>
    <p role="status" class="text-sm text-muted">
      {#if !computer.tracingSupported}Update this computer to use tracing.
      {:else if traceState?.active}Tracing until {new Date(Number(traceState.expiresAtMs)).toLocaleTimeString()}. Stops
        automatically.
      {:else}Tracing is off. Samples expire within 10 minutes after the session ends.{/if}
    </p>
    <div class="grid min-w-0 gap-3 sm:grid-cols-2">
      <Field label="Process"
        ><Select
          value={process}
          options={processes}
          disabled={busy || traceState?.active}
          onchange={(value) => (process = value)}
        /></Field
      >
      <Field label="Duration"
        ><Select
          value={minutes}
          disabled={busy || traceState?.active}
          options={[
            { value: "1", label: "1 minute" },
            { value: "5", label: "5 minutes" },
            { value: "10", label: "10 minutes" },
          ]}
          onchange={(value) => (minutes = value)}
        /></Field
      >
    </div>
    <div class="flex flex-wrap gap-2">
      <Button disabled={!connected || traceState?.active || busy} loading={busy} onclick={() => action("start")}
        >Start deeper tracing</Button
      >
      <Button disabled={!connected || !traceState?.active || busy} onclick={() => action("stop")}>Stop tracing</Button>
      <Button disabled={!connected || !traceState?.leaseId || busy} onclick={() => action("export")}
        >Export samples</Button
      >
    </div>
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    {#if message}<p role="status" class="text-sm text-muted">{message}</p>{/if}
  </div>
</SettingsGroup>

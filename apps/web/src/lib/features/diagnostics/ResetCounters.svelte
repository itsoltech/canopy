<script lang="ts">
  import { create, toJson } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import { queries } from "#lib/shared/queries.svelte.ts";
  import { diagnosticsEpochs } from "./read.ts";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import { clientMeasurements } from "./client.ts";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";

  let {
    computer,
    localComputerId,
    onreset,
  }: {
    computer: ui.ComputerDiagnostics;
    localComputerId: string | undefined;
    onreset(): void;
  } = $props();

  let resetting = $state(false);
  let process = $state("gateway");
  let busy = $state(false);
  let error = $state("");

  const processes = $derived([
    { value: "gateway", label: "Gateway" },
    ...computer.links
      .filter((link) => link.kind === "worker" && link.online)
      .map((link) => ({ value: `worker:${link.targetId}`, label: link.name })),
  ]);

  async function reset() {
    if (busy) return;
    const target = computer;
    const local = target.computerId === localComputerId;
    busy = true;
    error = "";

    try {
      const receipt = decode(
        ui.DiagnosticsReceiptSchema,
        await requestJson(
          "POST",
          "/api/diagnostics/reset",
          toJson(
            ui.ResetDiagnosticsRequestSchema,
            create(ui.ResetDiagnosticsRequestSchema, {
              computerId: target.computerId,
              processId: process,
              epoch: target.epoch,
              actionId: crypto.randomUUID(),
            }),
          ),
        ),
      );

      diagnosticsEpochs.reset(target.computerId, receipt.epoch, receipt.epochStartedAtMs);
      queries.forget((key) => key.startsWith("GetDiagnostics:") || key.startsWith("GetComputerDiagnostics:"));

      if (local) clientMeasurements.clear(receipt.epoch);
      resetting = false;
      toast("Counters reset");
      onreset();
    } catch {
      error = "Could not reset counters. Refresh diagnostics and retry.";
    } finally {
      busy = false;
    }
  }
</script>

<SettingsGroup title="Performance counters" description={computer.name}>
  <div class="grid justify-items-start gap-2 p-4">
    <Button
      disabled={computer.status !== "online" || computer.restoring}
      onclick={() => {
        process = "gateway";
        error = "";
        resetting = true;
      }}>Reset counters</Button
    >
  </div>
</SettingsGroup>

<Dialog
  bind:open={resetting}
  title="Reset counters?"
  description={`Start a new diagnostics baseline for ${computer.name}.`}
  dismissible={!busy}
>
  <div class="grid gap-4">
    <Field label="Process"><Select value={process} options={processes} onchange={(value) => (process = value)} /></Field
    >
    <p class="text-sm text-muted">
      Clears this process’s diagnostic history and findings. Running work, live gauges and runtime governor limits
      continue.
    </p>
    {#if error}<Alert tone="error">{error}</Alert>{/if}
  </div>
  {#snippet footer()}<div class="flex justify-end gap-2">
      <Button disabled={busy} onclick={() => (resetting = false)}>Cancel</Button><Button loading={busy} onclick={reset}
        >Reset counters</Button
      >
    </div>{/snippet}
</Dialog>

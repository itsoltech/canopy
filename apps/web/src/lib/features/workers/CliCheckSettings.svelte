<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import { updateCheckChoices } from "@canopy/domain/update-checks";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import PreferenceRow from "#lib/features/settings/PreferenceRow.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { requestJson } from "#lib/shared/http.ts";
  import { encode } from "#lib/shared/wire.ts";
  import { formatDateTime } from "#lib/shared/format.ts";

  let { worker }: { worker?: ui.Worker } = $props();
  const settings = useSettings();
  const account = $derived(settings.user.cliUpdates?.intervalMinutes ?? 360);

  const value = $derived(
    worker
      ? worker.cliUpdateCheckMinutes === undefined
        ? "inherit"
        : String(worker.cliUpdateCheckMinutes)
      : String(account),
  );

  let pending = $state(false);
  let error = $state("");

  async function change(value: string) {
    if (pending) return;
    error = "";
    pending = true;

    try {
      if (!worker) await settings.updateCliUpdates(Number(value));
      else
        await requestJson(
          "PUT",
          "/api/workers/cli/settings",
          encode(
            ui.SetWorkerCliUpdateSettingsRequestSchema,
            create(ui.SetWorkerCliUpdateSettingsRequestSchema, {
              workerId: worker.id,
              expectedConfigVersion: worker.configVersion,
              ...(value !== "inherit" && { intervalMinutes: Number(value) }),
            }),
          ),
        );
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not save the check frequency. Try again.";
    } finally {
      pending = false;
    }
  }
</script>

<PreferenceRow
  title={worker ? "CLI update checks on this worker" : "Agent CLI update check frequency"}
  description={worker
    ? "Override how often this worker checks for agent CLI releases."
    : "Set how often your workers check for agent CLI releases."}
  changed={worker ? worker.cliUpdateCheckMinutes !== undefined : account !== 360}
  onreset={() => change(worker ? "inherit" : "360")}
>
  {#snippet control()}<div class="w-56 max-w-full">
      <Select
        aria-label={worker ? "Worker CLI check frequency" : "Agent CLI update check frequency"}
        {value}
        disabled={pending || Boolean(worker?.nodeId)}
        onchange={change}
        options={worker
          ? [
              {
                value: "inherit",
                label: `Use account (${updateCheckChoices.find((c) => c.value === String(account))?.label ?? "Every 6 hours"})`,
              },
              ...updateCheckChoices,
            ]
          : updateCheckChoices}
      />
    </div>{/snippet}
  {#if worker}<p class="mt-1 text-sm/5 text-zinc-500 tabular-nums dark:text-zinc-400" role="status">
      Last checked {formatDateTime(worker.cliUpdatesCheckedAt) || "never"} · Next check {worker.effectiveCliUpdateCheckMinutes ===
      0
        ? "manual only"
        : formatDateTime(worker.cliUpdatesNextCheckAt) || "when the gateway checks"}
    </p>
  {:else}<p class="mt-1 text-sm/5 text-zinc-500 dark:text-zinc-400">
      Checks never install updates. You can still check manually.
    </p>{/if}
</PreferenceRow>
{#if error}<Alert tone="error">{error}</Alert>{/if}

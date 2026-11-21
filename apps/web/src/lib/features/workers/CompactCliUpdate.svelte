<script lang="ts">
  import { CliInstallMethod, type ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { cliManagedExternally } from "@canopy/domain/release/update-actions";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import UpdateItem from "./UpdateItem.svelte";
  import { cliCurrent } from "./compact-updates.ts";
  import { cliActions, cliLabel, versionProblem } from "./cli-tools.svelte.ts";
  import { cliExternalInstructions } from "./cli-update-instructions.ts";
  import type { UpdatesState } from "./updates.svelte.ts";
  import { updateInProgress } from "@canopy/domain/release/update-status";

  let {
    worker,
    item,
    updates,
    nodeId = "",
    class: className,
  }: {
    worker: ui.Worker;
    item: ui.WorkerCliTool;
    updates: UpdatesState;
    /** The linked computer the worker belongs to; empty for this computer. */
    nodeId?: string;
    class?: ClassValue;
  } = $props();

  const cli = cliActions();
  const tool = $derived(item.tool);
  const external = $derived(cliManagedExternally(item));
  const key = $derived(`${worker.id}/${tool?.provider}`);
  const busy = $derived(tool?.install?.state === "running" || cli.pending[key]);

  const blocked = $derived(!worker.online || !!item.blockedReason || !!busy || updates.cliBlocked(worker.id, nodeId));

  const error = $derived(
    cli.errors[key] || (tool?.install?.state === "failed" ? tool.install.error : "") || item.latest?.error || "",
  );

  const installed = $derived(
    !!tool && tool.method !== CliInstallMethod.NOT_INSTALLED && tool.method !== CliInstallMethod.UNSPECIFIED,
  );

  const status = $derived(
    !worker.online
      ? "Offline"
      : busy
        ? "updating"
        : error
          ? "failed"
          : cliCurrent(item)
            ? "current"
            : external || (!item.action && item.managedBy)
              ? "Managed externally"
              : item.action
                ? "available"
                : "Unavailable",
  );

  const detail = $derived(
    (external ? cliExternalInstructions(item) : "") ||
      item.blockedReason ||
      error ||
      (tool && versionProblem(tool)) ||
      item.managedBy ||
      tool?.detail ||
      "",
  );
</script>

{#if tool}
  <UpdateItem
    name={`${cliLabel(tool.provider)} · ${worker.name}`}
    icon="command-line"
    current={tool.version || (installed ? "" : "Not installed")}
    target={item.latest?.version}
    {status}
    error={status === "failed" ? error : ""}
    busy={updateInProgress(status)}
    class={[!worker.online && "opacity-50", className]}
  >
    {#snippet action()}
      {#if status === "failed" && item.action && !external}
        <IconButton
          icon="repeat"
          size="sm"
          label="Retry"
          disabled={blocked}
          onclick={() => {
            if (!blocked) void cli.install(worker.id, tool.provider);
          }}
        />
      {:else if item.action && !external && !updateInProgress(status)}
        <IconButton
          icon={item.action === "install" ? "plus" : "arrow-down-tray"}
          size="sm"
          label={`${item.action === "install" ? "Install" : "Update"} ${cliLabel(tool.provider)} on ${worker.name}`}
          tooltipText={`${item.action === "install" ? "Install" : "Update"} ${cliLabel(tool.provider)} on ${worker.name}${detail ? `. ${detail}` : ""}`}
          disabled={blocked}
          onclick={() => {
            if (!blocked) void cli.install(worker.id, tool.provider);
          }}
        />
      {:else if detail && !updateInProgress(status)}<IconButton
          icon="information-circle"
          size="sm"
          label={detail}
          tooltipOptions={{ touch: "tap" }}
        />{/if}
    {/snippet}
  </UpdateItem>
{/if}

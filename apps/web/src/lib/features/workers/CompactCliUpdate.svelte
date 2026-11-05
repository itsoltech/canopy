<script lang="ts">
  import { CliInstallMethod, Provider, type ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import UpdateItem from "./UpdateItem.svelte";
  import { cliCurrent } from "./compact-updates.ts";
  import { cliActions, cliLabel, versionProblem } from "./cli-tools.svelte.ts";

  let {
    worker,
    item,
    disabled = false,
    class: className,
  }: { worker: ui.Worker; item: ui.WorkerCliTool; disabled?: boolean; class?: ClassValue } = $props();

  const cli = cliActions();
  const tool = $derived(item.tool);
  const key = $derived(`${worker.id}/${tool?.provider}`);
  const busy = $derived(tool?.install?.state === "running" || cli.pending[key]);

  const error = $derived(
    cli.errors[key] || (tool?.install?.state === "failed" ? tool.install.error : "") || item.latest?.error || "",
  );

  const installed = $derived(
    !!tool && tool.method !== CliInstallMethod.NOT_INSTALLED && tool.method !== CliInstallMethod.UNSPECIFIED,
  );

  const detail = $derived(
    item.blockedReason || error || (tool && versionProblem(tool)) || item.managedBy || tool?.detail || "",
  );
</script>

{#if tool}
  <UpdateItem
    name={`${cliLabel(tool.provider)} · ${worker.name}`}
    icon="command-line"
    current={tool.version || (installed ? "" : "Not installed")}
    target={item.latest?.version}
    status={busy
      ? "Installing"
      : error
        ? "Failed"
        : cliCurrent(item)
          ? "Up to date"
          : item.action
            ? "Available"
            : item.managedBy
              ? "External"
              : "Unavailable"}
    tone={error ? "rose" : busy ? "amber" : "neutral"}
    {busy}
    {error}
    {detail}
    class={className}
  >
    {#snippet action()}
      {#if item.action && !busy}
        <IconButton
          icon={item.action === "install" ? "plus" : "arrow-up"}
          size="sm"
          label={`${item.action === "install" ? "Install" : "Update"} ${cliLabel(tool.provider)} on ${worker.name}${detail ? `: ${detail}` : ""}`}
          disabled={disabled || !!item.blockedReason}
          onclick={() => void cli.install(worker.id, tool.provider)}
        />
      {:else if detail}<IconButton icon="information-circle" size="sm" label={detail} />{/if}
    {/snippet}
  </UpdateItem>
{/if}

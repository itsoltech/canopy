<script lang="ts">
  import { CliInstallMethod, type ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import { swap } from "#lib/shared/ui/motion.ts";

  /** Where a CLI stands: installing, failed, behind the latest release, or current (nothing when it cannot tell). */
  let { item, class: className }: { item: ui.WorkerCliTool; class?: ClassValue } = $props();
  const tool = $derived(item.tool!);

  const installed = $derived(
    tool.method !== CliInstallMethod.NOT_INSTALLED && tool.method !== CliInstallMethod.UNSPECIFIED,
  );

  const target = $derived(
    tool.install?.targetVersion && tool.install.targetVersion !== "latest" ? ` · ${tool.install.targetVersion}` : "",
  );

  const state = $derived(
    tool.install?.state === "running"
      ? "installing"
      : tool.install?.state === "failed"
        ? "failed"
        : item.updateAvailable
          ? "update"
          : installed && item.latest?.version && !item.latest.error
            ? "current"
            : "",
  );
</script>

{#key state}
  <div in:swap role="status" class={["flex", className]}>
    {#if state === "installing"}<Badge tone="sky">{installed ? "Updating" : "Installing"}{target}</Badge>
    {:else if state === "failed"}<Badge tone="rose">Install failed</Badge>
    {:else if state === "update"}<Badge tone="amber">Update available · {item.latest?.version}</Badge>
    {:else if state === "current"}<Badge tone="emerald">Up to date</Badge>{/if}
  </div>
{/key}

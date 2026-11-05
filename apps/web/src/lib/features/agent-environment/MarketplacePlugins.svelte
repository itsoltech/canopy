<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import type { PluginState } from "./plugin-state.svelte.ts";
  import LibraryRow from "./LibraryRow.svelte";
  import LibraryTargets from "./LibraryTargets.svelte";
  import ItemStatus from "./ItemStatus.svelte";
  import { librarySource } from "./library-meta.ts";
  import Badge from "#lib/shared/ui/Badge.svelte";

  let {
    controller,
    market,
    class: className,
  }: {
    controller: PluginState;
    market: ui.EnvironmentMarketplace;
    class?: ClassValue;
  } = $props();
</script>

{#if controller.catalog(market).length}
  <div class={["grid min-w-0 divide-y divide-divider", className]}>
    {#each controller.catalog(market) as plugin (plugin.artifact?.name)}
      {@const installed = controller.environment.snapshot.plugins.find(
        (p) => p.marketplaceId === market.id && p.assignment?.artifact?.name === plugin.artifact?.name,
      )}
      {@const assignment = installed?.assignment}
      {@const removed = !market.plugins.some((p) => p.artifact?.name === plugin.artifact?.name)}
      {@const update =
        assignment && !plugin.unavailableReason && assignment.artifact?.checksum !== plugin.artifact?.checksum}
      <LibraryRow
        id={assignment?.id}
        name={assignment?.name || plugin.artifact?.name || "Unavailable plugin"}
        meta={`${plugin.harnesses.join(" / ")}${assignment ? ` · v${assignment.version}` : ""} · ${plugin.artifact?.files.length ?? 0} files · ${librarySource(market.source?.url)} · ${assignment ? "Pinned" : plugin.unavailableReason || "Ready to review"}`}
        disabled={controller.environment.busy || (!assignment && Boolean(plugin.unavailableReason))}
        onedit={() => controller.edit(market, plugin)}
        onremove={assignment ? () => void controller.removePlugin(assignment.id) : undefined}
        editLabel={assignment ? "Edit plugin" : "Review and enable plugin"}
        removeLabel="Remove plugin"
      >
        {#snippet status()}
          {#if assignment}<ItemStatus
              workers={controller.environment.snapshot.workers}
              selector={assignment.selector}
              kind="plugins"
              id={assignment.id}
              label={removed ? "Removed upstream" : update ? "Update available" : ""}
            />
          {:else}<Badge compact tone={plugin.unavailableReason ? "amber" : "neutral"}
              >{plugin.unavailableReason ? "Unavailable" : "Not assigned"}</Badge
            >{/if}
        {/snippet}
        {#snippet targets()}
          {#if assignment}<LibraryTargets
              selector={assignment.selector}
              workers={controller.environment.snapshot.workers}
            />{/if}
        {/snippet}
      </LibraryRow>
    {/each}
  </div>
{:else}<p class="py-2 text-sm text-muted">This catalog has no plugins. Check upstream to refresh it.</p>{/if}

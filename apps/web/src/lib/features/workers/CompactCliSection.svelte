<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import CompactCliUpdate from "./CompactCliUpdate.svelte";
  import UpdateGroupLabel from "./UpdateGroupLabel.svelte";
  import { cliActions } from "./cli-tools.svelte.ts";
  import type { UpdatesState } from "./updates.svelte.ts";
  import UpdateBadge from "./UpdateBadge.svelte";
  import { cliCurrent } from "./compact-updates.ts";

  /** Agent CLIs of every computer, collapsed: the count and one badge say whether anything inside needs attention. */
  let {
    groups,
    updates,
    class: className,
  }: {
    groups: { name: string; nodeId: string; home: ui.UpdatesSnapshot }[];
    updates: UpdatesState;
    class?: ClassValue;
  } = $props();

  const cli = cliActions();

  const sections = $derived(
    groups
      .map((group) => ({
        ...group,
        items: group.home.cliWorkers.flatMap((worker) =>
          worker.cliTools.filter((item) => !!item.tool).map((item) => ({ worker, item })),
        ),
      }))
      .filter((group) => group.items.length),
  );

  const items = $derived(sections.flatMap((section) => section.items));

  // One badge for the collapsed section: the most urgent of its rows, in the rows' own words.
  const statuses = $derived(
    items.map(({ worker, item }) => {
      const key = `${worker.id}/${item.tool?.provider}`;

      if (item.tool?.install?.state === "running" || cli.pending[key]) return "updating";

      if (item.tool?.install?.state === "failed" || cli.errors[key]) return "failed";

      return !cliCurrent(item) && (item.updateAvailable || item.action) ? "available" : "current";
    }),
  );

  const available = $derived(statuses.filter((status) => status === "available").length);

  const overall = $derived(
    statuses.includes("failed")
      ? "failed"
      : statuses.includes("updating")
        ? "updating"
        : available
          ? `${available} available`
          : "current",
  );
</script>

{#if items.length}
  <Disclosure summaryClass="py-2 text-xs/5 text-muted" class={["border-divider", className]}>
    {#snippet summary()}
      <!-- The badge lines up with the rows' badges: their action column follows it. -->
      <span class="flex min-w-0 items-center gap-2 pr-10 sm:pr-9">
        <span class="min-w-0 flex-1 truncate">Agent CLIs · {items.length}</span>
        <span class="flex min-w-28 shrink-0 justify-end sm:min-w-23">
          {#if overall.endsWith("available")}{#key overall}<Badge compact tone="sky" class="t-swap">{overall}</Badge
              >{/key}{:else}<UpdateBadge status={overall} />{/if}
        </span>
      </span>
    {/snippet}
    {#each sections as section (section.nodeId)}
      {#if sections.length > 1}<UpdateGroupLabel class="mt-1">{section.name}</UpdateGroupLabel>{/if}
      {#each section.items as entry (`${entry.worker.id}/${entry.item.tool?.provider}`)}
        <CompactCliUpdate {...entry} {updates} nodeId={section.nodeId} />
      {/each}
    {/each}
  </Disclosure>
{/if}

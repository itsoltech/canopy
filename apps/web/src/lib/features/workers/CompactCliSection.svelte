<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import CompactCliUpdate from "./CompactCliUpdate.svelte";
  import UpdateGroupLabel from "./UpdateGroupLabel.svelte";
  import { cliActions } from "./cli-tools.svelte.ts";
  import { cliCurrent } from "./compact-updates.ts";

  /** Agent CLIs of every computer, collapsed: the count and one badge say whether anything inside needs attention. */
  let {
    groups,
    disabled = false,
    class: className,
  }: {
    groups: { name: string; nodeId: string; home: ui.UpdatesSnapshot }[];
    disabled?: boolean;
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

  const failed = $derived(
    items.filter(
      ({ worker, item }) =>
        item.tool?.install?.state === "failed" || !!cli.errors[`${worker.id}/${item.tool?.provider}`],
    ).length,
  );

  const installing = $derived(items.some(({ item }) => item.tool?.install?.state === "running"));
  const available = $derived(items.filter(({ item }) => !cliCurrent(item) && (item.updateAvailable || !!item.action)));
</script>

{#if items.length}
  <Disclosure summaryClass="py-2 text-xs/5 text-muted" class={["border-divider", className]}>
    {#snippet summary()}
      <!-- The badge lines up with the rows' badges: their action column follows it. -->
      <span class="flex min-w-0 items-center gap-2 pr-10 sm:pr-9">
        <span class="min-w-0 flex-1 truncate">Agent CLIs · {items.length}</span>
        {#if failed}<Badge compact tone="rose">Failed</Badge>
        {:else if installing}<Badge compact tone="amber">Installing</Badge>
        {:else if available.length}<Badge compact>{available.length} available</Badge>{/if}
      </span>
    {/snippet}
    {#each sections as section (section.nodeId)}
      {#if sections.length > 1}<UpdateGroupLabel class="mt-1">{section.name}</UpdateGroupLabel>{/if}
      {#each section.items as entry (`${entry.worker.id}/${entry.item.tool?.provider}`)}
        <CompactCliUpdate {...entry} {disabled} />
      {/each}
    {/each}
  </Disclosure>
{/if}

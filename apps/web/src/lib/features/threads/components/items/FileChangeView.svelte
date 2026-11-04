<script lang="ts">
  import { ItemStatus, type FileChange } from "@canopy/contracts";
  import { basename } from "#lib/shared/format.ts";
  import FileDiffEntry from "./FileDiffEntry.svelte";
  import ItemFrame from "./ItemFrame.svelte";
  import DiffCounts from "./DiffCounts.svelte";
  import { diffCounts } from "./tools/changes.ts";

  /** Files the agent added, edited, moved or deleted, each with its diff. */
  let { change, status }: { change: FileChange; status: ItemStatus } = $props();

  const verb = $derived(
    status === ItemStatus.IN_PROGRESS ? "Editing" : status === ItemStatus.DECLINED ? "Proposed" : "Edited",
  );

  const counts = $derived(diffCounts(change.changes));
</script>

<ItemFrame icon="pencil-square" {status}>
  {#snippet title()}
    <span class="flex min-w-0 gap-1.5">
      <span class="shrink-0">{verb}</span>
      <span class="truncate text-zinc-800 dark:text-zinc-200"
        >{change.changes.map((c) => basename(c.path)).join(", ") || "files"}</span
      >
    </span>
  {/snippet}
  {#snippet aside()}
    <DiffCounts {...counts} />
    {#if change.changes.length > 1}<span>{change.changes.length} files</span>{/if}
  {/snippet}
  {#each change.changes as entry, index (index)}
    <FileDiffEntry
      path={entry.path}
      kind={entry.kind}
      movePath={entry.movePath}
      diff={entry.diff}
      diffBlob={entry.diffBlob}
    />
  {/each}
</ItemFrame>

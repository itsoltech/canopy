<script lang="ts">
  import { ItemStatus, type FileChange } from "@open-agents/contracts";
  import { basename } from "#lib/shared/format.ts";
  import FileDiffEntry from "./FileDiffEntry.svelte";
  import ItemFrame from "./ItemFrame.svelte";

  /** Files the agent added, edited, moved or deleted, each with its diff. */
  let { change, status }: { change: FileChange; status: ItemStatus } = $props();

  const verb = $derived(status === ItemStatus.IN_PROGRESS ? "Editing" : status === ItemStatus.DECLINED ? "Proposed" : "Edited");
</script>

<ItemFrame icon="pencil-square" {status}>
  {#snippet title()}
    <span class="flex min-w-0 gap-1.5">
      <span class="shrink-0">{verb}</span>
      <span class="truncate font-medium text-zinc-950 dark:text-white">{change.changes.map((c) => basename(c.path)).join(", ") || "files"}</span>
    </span>
  {/snippet}
  {#snippet aside()}
    {#if change.changes.length > 1}<span>{change.changes.length} files</span>{/if}
  {/snippet}
  {#each change.changes as entry, index (index)}
    <FileDiffEntry path={entry.path} kind={entry.kind} movePath={entry.movePath} diff={entry.diff} diffBlob={entry.diffBlob} />
  {/each}
</ItemFrame>

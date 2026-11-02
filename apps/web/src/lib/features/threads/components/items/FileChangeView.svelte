<script lang="ts">
  import { ItemStatus, type FileChange } from "@open-agents/contracts";
  import { basename, formatBytes } from "#lib/shared/format.ts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import { languageOfPath } from "#lib/shared/ui/code/languages.ts";
  import type { Tone } from "#lib/shared/ui/tone.ts";
  import Diff from "../Diff.svelte";
  import ItemFrame from "./ItemFrame.svelte";

  /** Files the agent added, edited, moved or deleted, each with its diff. */
  let { change, status }: { change: FileChange; status: ItemStatus } = $props();

  const kinds: Record<string, { label: string; tone: Tone }> = {
    add: { label: "Added", tone: "emerald" },
    update: { label: "Edited", tone: "sky" },
    delete: { label: "Deleted", tone: "rose" },
    move: { label: "Moved", tone: "violet" },
  };
  const kind = (k: string) => kinds[k] ?? { label: k || "Changed", tone: "neutral" as Tone };
  const verb = $derived(status === ItemStatus.IN_PROGRESS ? "Editing" : status === ItemStatus.DECLINED ? "Proposed" : "Edited");
  const stats = (diff: string) => {
    let added = 0;
    let removed = 0;
    for (const line of diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }
    return { added, removed };
  };
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
    {@const look = kind(entry.kind)}
    {@const counts = stats(entry.diff)}
    <div class="grid gap-1.5">
      <div class="flex min-w-0 items-center gap-2 text-sm/5">
        <Badge tone={look.tone}>{look.label}</Badge>
        <code class="truncate font-mono text-[0.8125rem] text-zinc-950 dark:text-white" title={entry.path}>{entry.path}{entry.movePath ? ` → ${entry.movePath}` : ""}</code>
        {#if entry.diff}
          <span class="shrink-0 font-mono text-xs/5 tabular-nums">
            <span class="text-emerald-700 dark:text-emerald-400">+{counts.added}</span>
            <span class="text-rose-700 dark:text-rose-400">−{counts.removed}</span>
          </span>
        {/if}
      </div>
      {#if entry.diff}
        <Diff diff={entry.diff} label="Diff of {entry.path}" lang={languageOfPath(entry.movePath || entry.path)} />
      {:else if entry.diffBlob}
        <p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Diff ({formatBytes(entry.diffBlob.sizeBytes)}) is stored on the gateway; viewing it here is not supported yet.</p>
      {/if}
    </div>
  {/each}
</ItemFrame>

<script lang="ts">
  import type { BlobRef } from "@open-agents/contracts";
  import { formatBytes } from "#lib/shared/format.ts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import { languageOfPath } from "#lib/shared/ui/code/languages.ts";
  import type { Tone } from "#lib/shared/ui/tone.ts";
  import Diff from "../Diff.svelte";
  import DiffCounts from "./DiffCounts.svelte";
  import { diffCounts } from "./tools/changes.ts";

  /** One changed file: what happened to it, its path, lines added and removed, and its diff (highlighted by file type). */
  let { path, kind, movePath = "", diff, diffBlob }: { path: string; kind: string; movePath?: string; diff: string; diffBlob?: BlobRef | undefined } = $props();

  const kinds: Record<string, { label: string; tone: Tone }> = {
    add: { label: "Added", tone: "emerald" },
    update: { label: "Edited", tone: "sky" },
    delete: { label: "Deleted", tone: "rose" },
    move: { label: "Moved", tone: "violet" },
  };
  const look = $derived(kinds[kind] ?? { label: "Changed", tone: "neutral" as Tone });
  const counts = $derived(diffCounts([{ diff }]));
</script>

<div class="grid gap-1.5">
  <div class="flex min-w-0 items-center gap-2 text-sm/5">
    <Badge tone={look.tone}>{look.label}</Badge>
    <code class="truncate font-mono text-[0.8125rem] text-zinc-950 dark:text-white" title={path}>{path}{movePath ? ` → ${movePath}` : ""}</code>
    {#if diff}
      <DiffCounts {...counts} />
    {/if}
  </div>
  {#if diff}
    <Diff data-quote-kind="diff" {diff} label="Diff of {path}" lang={languageOfPath(movePath || path)} />
  {:else if diffBlob}
    <p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Diff ({formatBytes(diffBlob.sizeBytes)}) is stored on the gateway; viewing it here is not supported yet.</p>
  {/if}
</div>

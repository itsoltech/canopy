<script lang="ts">
  import type { BlobRef } from "@open-agents/contracts";
  import { formatBytes } from "#lib/shared/format.ts";
  import CodeBlock from "#lib/shared/ui/CodeBlock.svelte";
  import { useRemembered } from "#lib/shared/ui/memory.ts";

  /**
   * Output of a command, tool or task; large output lives in a blob on the gateway. With `tail`, long
   * output shows only its last lines (live output of background work) until you expand it.
   */
  let {
    output,
    blob,
    label,
    empty = "No output.",
    tail,
  }: { output: string; blob?: BlobRef | undefined; label: string; empty?: string; tail?: number | undefined } = $props();

  const lines = $derived(output.replace(/\n$/, "").split("\n"));
  const cut = $derived(tail !== undefined && lines.length > tail);
  // Remembered while the row is scrolled out of a virtual list.
  const memory = useRemembered<boolean>("output-all");
  let all = $state(memory?.get() ?? false);
  $effect(() => memory?.set(all));
  const shown = $derived(cut && !all ? lines.slice(-(tail ?? 0)).join("\n") : output);
</script>

{#if output}
  <div class="grid gap-1">
    {#if cut}
      <p class="flex items-center justify-between gap-3 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
        <span class="tabular-nums">{all ? `${lines.length} lines` : `Last ${tail} of ${lines.length} lines`}</span>
        <button type="button" class="rounded-md font-medium text-zinc-700 hover:text-zinc-950 focus-ring dark:text-zinc-300 dark:hover:text-white" aria-expanded={all} onclick={() => (all = !all)}>
          {all ? "Show the end only" : "Show all output"}
        </button>
      </p>
    {/if}
    <CodeBlock text={shown} {label} />
  </div>
{/if}
{#if blob}
  <p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
    Full output ({formatBytes(blob.sizeBytes)}) is stored on the gateway; viewing it here is not supported yet.
  </p>
{:else if !output}
  <p class="text-sm/5 text-zinc-500 italic sm:text-xs/5 dark:text-zinc-400">{empty}</p>
{/if}

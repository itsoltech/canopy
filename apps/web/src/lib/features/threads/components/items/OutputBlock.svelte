<script lang="ts">
  import type { BlobRef } from "@open-agents/contracts";
  import { formatBytes } from "#lib/shared/format.ts";
  import CodeBlock from "#lib/shared/ui/CodeBlock.svelte";

  /** Output of a command, tool or task; large output lives in a blob on the gateway. */
  let { output, blob, label, empty = "No output." }: { output: string; blob?: BlobRef | undefined; label: string; empty?: string } = $props();
</script>

{#if output}
  <CodeBlock text={output} {label} />
{/if}
{#if blob}
  <p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
    Full output ({formatBytes(blob.sizeBytes)}) is stored on the gateway; viewing it here is not supported yet.
  </p>
{:else if !output}
  <p class="text-sm/5 text-zinc-500 italic sm:text-xs/5 dark:text-zinc-400">{empty}</p>
{/if}

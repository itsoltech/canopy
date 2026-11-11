<script lang="ts">
  import type { BlobRef } from "@canopy/contracts";
  import FileAvailability from "#lib/features/attachments/FileAvailability.svelte";
  import { useThreadDirectory } from "#lib/features/threads/thread-directory.ts";
  import { formatBytes } from "#lib/shared/format.ts";
  import CodeBlock from "#lib/shared/ui/CodeBlock.svelte";
  import MoreButton from "#lib/shared/ui/MoreButton.svelte";
  import { useRemembered } from "#lib/shared/ui/memory.ts";
  import { LineReveal } from "#lib/shared/ui/streaming/line-reveal.svelte.ts";

  /**
   * Output of a command, tool or task; large output lives in a blob on the gateway. With `tail`, long
   * output shows only its last lines (live output of background work) until you expand it. While
   * `streaming`, output shows line by line (`LineReveal`). `quoteKind`: the output can be quoted as this kind of
   * source (selection.ts).
   */
  let {
    output,
    blob,
    label,
    empty = "No output.",
    tail,
    streaming = false,
    quoteKind,
  }: {
    output: string;
    blob?: BlobRef | undefined;
    label: string;
    empty?: string;
    tail?: number | undefined;
    streaming?: boolean;
    quoteKind?: "command_output" | "tool_call" | undefined;
  } = $props();

  const reveal = new LineReveal(
    () => output,
    () => streaming,
  );

  const directory = useThreadDirectory();
  const text = $derived(reveal.text);
  const lines = $derived(tail === undefined ? [] : text.replace(/\n$/, "").split("\n"));
  const cut = $derived(tail !== undefined && lines.length > tail);

  // Remembered while the row is scrolled out of a virtual list.
  const memory = useRemembered<boolean>("output-all");
  let all = $state(memory?.get() ?? false);

  $effect(() => memory?.set(all));

  const shown = $derived(cut && !all ? lines.slice(-(tail ?? 0)).join("\n") : text);
</script>

{#if text}
  <div class="grid gap-1">
    {#if cut}
      <MoreButton
        expanded={all}
        onclick={() => (all = !all)}
        note={all ? `${lines.length} lines` : `Last ${tail} of ${lines.length} lines`}
        >{all ? "Show the end only" : "Show all output"}</MoreButton
      >
    {/if}
    <CodeBlock text={shown} {label} data-quote-kind={quoteKind} />
  </div>
{/if}
{#if blob}
  <FileAvailability entityId={directory.currentId} name="Full output ({formatBytes(blob.sizeBytes)})">
    <p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      Full output ({formatBytes(blob.sizeBytes)}) is stored on the gateway; viewing it here is not supported yet.
    </p>
  </FileAvailability>
{:else if !text}
  <p class="text-sm/5 text-zinc-500 italic sm:text-xs/5 dark:text-zinc-400">{empty}</p>
{/if}

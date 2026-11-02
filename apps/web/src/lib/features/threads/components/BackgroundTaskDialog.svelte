<script lang="ts">
  import { ItemStatus, type Item } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { formatBytes } from "#lib/shared/format.ts";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import { backgroundName, type BackgroundEntry } from "../background-tasks.ts";
  import BackgroundTaskStatus from "./BackgroundTaskStatus.svelte";
  import BackgroundTaskStop from "./BackgroundTaskStop.svelte";
  import BackgroundOutput from "./BackgroundOutput.svelte";

  let { open = $bindable(false), entry, threadId, cwd, source, class: className }: { open?: boolean; entry: BackgroundEntry; threadId: string; cwd: string; source?: Item | undefined; class?: ClassValue } = $props();
  const task = $derived(entry.item.content.value);
  const running = $derived(entry.item.status === ItemStatus.IN_PROGRESS);
  const command = $derived(source?.content.case === "commandExecution" ? source.content.value : undefined);
  let outputView = $state<{ latest(): void }>();
</script>

<Dialog bind:open title={backgroundName(task)} size="output" fullscreen class={className} onkeydown={(event) => { if (event.key === "End") { event.preventDefault(); outputView?.latest(); } }}>
  <div class="grid min-w-0 gap-3">
    {#if task.command}<pre class="max-h-24 overflow-auto font-mono text-xs/5 whitespace-pre-wrap break-words">{task.command}</pre>{/if}
    <div class="flex flex-wrap items-center justify-between gap-2">
      <BackgroundTaskStatus {entry} exitCode={command?.exitCode} />
      <div class="flex items-center gap-2">
        {#if running}<BackgroundTaskStop {threadId} itemId={entry.id} />{/if}
        <CopyButton text={task.output} label="Copy output" />
      </div>
    </div>
    <p class="truncate font-mono text-xs/5 text-zinc-500" title={command?.cwd || cwd}>{command?.cwd || cwd}</p>
    {#key entry.id}<BackgroundOutput bind:this={outputView} output={task.output} {running} />{/key}
    {#if task.outputBlob}
      <p class="text-xs/5 text-zinc-500">Full output ({formatBytes(task.outputBlob.sizeBytes)}) is stored on the gateway. Only streamed output is available here.</p>
    {/if}
    {#if task.stopReason}<p class="text-xs/5 text-zinc-500">{task.stopReason}</p>{/if}
  </div>
</Dialog>

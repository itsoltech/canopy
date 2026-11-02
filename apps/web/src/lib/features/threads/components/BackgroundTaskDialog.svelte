<script lang="ts">
  import { ItemStatus, type Item } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { formatBytes, formatSpan } from "#lib/shared/format.ts";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Terminal from "#lib/shared/ui/Terminal.svelte";
  import { terminalTitle } from "#lib/shared/ui/terminal.ts";
  import { backgroundStatus, type BackgroundEntry } from "../background-tasks.ts";
  import BackgroundTaskStatus from "./BackgroundTaskStatus.svelte";
  import BackgroundTaskStop from "./BackgroundTaskStop.svelte";

  let { open = $bindable(false), entry, threadId, cwd, source, class: className }: { open?: boolean; entry: BackgroundEntry; threadId: string; cwd: string; source?: Item | undefined; class?: ClassValue } = $props();
  const task = $derived(entry.item.content.value);
  const running = $derived(entry.item.status === ItemStatus.IN_PROGRESS);
  const command = $derived(source?.content.case === "commandExecution" ? source.content.value : undefined);
  const text = $derived(task.command || command?.command || "");
  const title = $derived(terminalTitle(text, task.description));
  const elapsed = $derived(entry.startedAt !== undefined && entry.completedAt !== undefined ? formatSpan(Math.max(0, entry.completedAt - entry.startedAt)) : "time unavailable");
  const exitLine = $derived(`[${entry.item.status === ItemStatus.COMPLETED ? `exited ${command?.exitCode ?? "(code unavailable)"}` : backgroundStatus(entry, command?.exitCode).toLowerCase()} · ${elapsed}]`);
</script>

<Dialog bind:open {title} size="output" fullscreen bare class={["h-[min(80dvh,46rem)] overflow-hidden", className]}>
  {#key entry.id}
    {#snippet notes()}
      {#if task.outputBlob}<p>Full output ({formatBytes(task.outputBlob.sizeBytes)}) is stored on the gateway. Only streamed output is available here.</p>{/if}
      {#if task.stopReason}<p>{task.stopReason}</p>{/if}
    {/snippet}
    <Terminal {title} cwd={command?.cwd || cwd} command={text} output={task.output} {running} {exitLine} footer={task.outputBlob || task.stopReason ? notes : undefined}>
      {#snippet status()}<BackgroundTaskStatus {entry} exitCode={command?.exitCode} />{/snippet}
      {#snippet actions()}
        {#if running}<BackgroundTaskStop {threadId} itemId={entry.id} />{/if}
        <IconButton icon="x-mark" label="Close" size="sm" onclick={() => (open = false)} />
      {/snippet}
    </Terminal>
  {/key}
</Dialog>

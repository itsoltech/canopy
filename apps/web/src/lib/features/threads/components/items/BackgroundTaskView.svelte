<script lang="ts">
  import { BackgroundTaskKind, ItemStatus, type BackgroundTask } from "@open-agents/contracts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import ItemFrame from "./ItemFrame.svelte";
  import OutputBlock from "./OutputBlock.svelte";
  import TaskProgressText from "./TaskProgressText.svelte";

  /** Work that outlives its turn (background shell, process, workflow); can finish between turns. */
  let { task, status }: { task: BackgroundTask; status: ItemStatus } = $props();
  const kinds: Partial<Record<BackgroundTaskKind, string>> = {
    [BackgroundTaskKind.SHELL]: "Shell",
    [BackgroundTaskKind.AGENT]: "Agent",
    [BackgroundTaskKind.WORKFLOW]: "Workflow",
    [BackgroundTaskKind.PROCESS]: "Process",
  };
  const stopReasons: Record<string, string> = {
    stopped_by_user: "Stopped by you",
    drain: "Stopped: worker draining",
    worker_restart: "Stopped: worker restarted",
    limit: "Stopped: limit reached",
    error: "Stopped by an error",
  };
</script>

<ItemFrame icon="bolt" {status} defaultOpen={status === ItemStatus.IN_PROGRESS}>
  {#snippet title()}
    <span class="flex min-w-0 gap-1.5">
      <span class="shrink-0">Background</span>
      <span class="truncate font-medium text-zinc-950 dark:text-white">{task.description || task.command || task.taskId}</span>
    </span>
  {/snippet}
  {#snippet aside()}
    {#if kinds[task.kind]}<Badge>{kinds[task.kind]}</Badge>{/if}
    <TaskProgressText progress={task.progress} />
  {/snippet}
  {#if task.command}<pre class="code-surface rounded-lg bg-zinc-950/2.5 p-3 text-zinc-950 dark:bg-white/5 dark:text-white">{task.command}</pre>{/if}
  {#if task.stopReason}<p class="text-sm/5 text-orange-700 sm:text-xs/5 dark:text-orange-400">{stopReasons[task.stopReason] ?? task.stopReason}</p>{/if}
  {#if task.progress?.summary}<p class="text-sm/5 text-zinc-600 sm:text-xs/5 dark:text-zinc-400">{task.progress.summary}</p>{/if}
  <OutputBlock output={task.output} blob={task.outputBlob} label="Output of {task.description || 'background task'}" empty={status === ItemStatus.IN_PROGRESS ? "Waiting for output…" : "No output."} />
</ItemFrame>

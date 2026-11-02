<script lang="ts">
  import { BackgroundTaskKind, ItemStatus, type BackgroundTask } from "@open-agents/contracts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import { humanizeEnum } from "#lib/shared/humanize.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import { swap } from "#lib/shared/ui/motion.ts";
  import { stopBackgroundTask } from "../../api.ts";
  import { useThreadDirectory } from "../../thread-directory.ts";
  import { backgroundStopLabel } from "@open-agents/domain/background-tasks";
  import ItemFrame from "./ItemFrame.svelte";
  import OutputBlock from "./OutputBlock.svelte";
  import TaskProgressText from "./TaskProgressText.svelte";
  import { useBackgroundOutput } from "../../background-output.ts";

  /**
   * Work that outlives its turn (background shell, process, workflow); can finish between turns. While it
   * runs: the tail of its live output and Stop (the worker ends it; the item then says it was stopped).
   */
  let { task, itemId, status }: { task: BackgroundTask; itemId: string; status: ItemStatus } = $props();
  const directory = useThreadDirectory();
  const openOutput = useBackgroundOutput();
  const kinds: Partial<Record<BackgroundTaskKind, string>> = {
    [BackgroundTaskKind.SHELL]: "Shell",
    [BackgroundTaskKind.AGENT]: "Agent",
    [BackgroundTaskKind.WORKFLOW]: "Workflow",
    [BackgroundTaskKind.PROCESS]: "Process",
  };
  const running = $derived(status === ItemStatus.IN_PROGRESS);
  const name = $derived(task.description || task.command.split("\n")[0] || task.taskId);

  let stopping = $state(false);
  let error = $state<string>();
  async function stop() {
    stopping = true;
    error = undefined;
    try {
      await stopBackgroundTask(directory.currentId, itemId);
      // Stays "Stopping…" until the worker reports the task ended (the item leaves IN_PROGRESS).
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Stopping failed";
      stopping = false;
    }
  }
</script>

<ItemFrame icon="bolt" {status} defaultOpen={running}>
  {#snippet title()}
    <span class="flex min-w-0 gap-1.5">
      <span class="shrink-0">Background</span>
      <span class="truncate font-medium text-zinc-950 dark:text-white">{name}</span>
    </span>
  {/snippet}
  {#snippet aside()}
    {#if kinds[task.kind]}<Badge>{kinds[task.kind]}</Badge>{/if}
    <TaskProgressText progress={task.progress} />
  {/snippet}
  {#if running && directory.currentId}
    <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400" role="status">
        {#key stopping}<span class="inline-block" in:swap>{stopping ? "Asked the worker to stop it…" : "Keeps running after the turn ends."}</span>{/key}
      </p>
      <Button size="sm" icon="stop" loading={stopping} onclick={stop}>{stopping ? "Stopping…" : "Stop"}</Button>
    </div>
    {#if error}<p class="text-sm/5 text-rose-700 sm:text-xs/5 dark:text-rose-400" role="alert">{error}</p>{/if}
  {/if}
  {#if task.command}<pre class="code-surface rounded-lg bg-zinc-950/2.5 p-3 text-zinc-950 dark:bg-white/5 dark:text-white">{task.command}</pre>{/if}
  {#if task.stopReason}<p class="text-sm/5 text-orange-700 sm:text-xs/5 dark:text-orange-400">{backgroundStopLabel(task.stopReason) === task.stopReason ? humanizeEnum(task.stopReason) : backgroundStopLabel(task.stopReason)}</p>{/if}
  {#if task.progress?.summary}<p class="text-sm/5 text-zinc-600 sm:text-xs/5 dark:text-zinc-400">{task.progress.summary}</p>{/if}
  <OutputBlock output={task.output} blob={task.outputBlob} label="Output of {name}" tail={12} empty={running ? "Waiting for output…" : "No output."} streaming={running} />
  {#if openOutput}<Button size="sm" icon="command-line" onclick={() => openOutput(itemId)}>Open output</Button>{/if}
</ItemFrame>

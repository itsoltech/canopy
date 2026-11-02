<script lang="ts">
  import { ItemStatus } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { backgroundHeadline, backgroundOutcome, backgroundTitle } from "@open-agents/domain/background-tasks";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { useBackgroundOutput } from "../background-output.ts";
  import { useThreadDirectory } from "../thread-directory.ts";

  /**
   * The platform told the agent how background tasks of this thread ended (a turn of its own, or a note steered into
   * the running turn): one compact system line per task, linking to its output. The note's full text is the agent's.
   */
  let { itemIds, class: className }: { itemIds: readonly string[]; class?: ClassValue } = $props();
  const directory = useThreadDirectory();
  const openOutput = useBackgroundOutput();

  function headline(id: string): { title: string; outcome: string } {
    const item = directory.item?.(id);
    if (item?.content.case !== "backgroundTask") return { title: id, outcome: "Background task ended" };
    const task = item.content.value;
    return { title: backgroundTitle(task, id), outcome: backgroundHeadline(backgroundOutcome(ItemStatus[item.status]), task.stopReason, task.exitCode) };
  }
</script>

<ul role="list" class={["flex flex-col gap-1", className]}>
  {#each itemIds as id (id)}
    {@const line = headline(id)}
    <li class="flex items-start gap-2 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      <span class="flex h-lh shrink-0 items-center"><Icon name="bolt" class="size-3.5" /></span>
      <p class="min-w-0 break-words">
        <span>{line.outcome}</span>
        <span aria-hidden="true">·</span>
        {#if openOutput}
          <button type="button" class="rounded-sm font-medium text-zinc-700 underline decoration-zinc-950/20 underline-offset-2 hover:decoration-zinc-950/50 focus-ring dark:text-zinc-300 dark:decoration-white/20 dark:hover:decoration-white/50" onclick={() => openOutput(id)}>{line.title}</button>
        {:else}
          <span class="font-medium text-zinc-700 dark:text-zinc-300">{line.title}</span>
        {/if}
      </p>
    </li>
  {/each}
</ul>

<script lang="ts">
  import { ItemStatus } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { backgroundHeadline, backgroundOutcome, backgroundTitle } from "@canopy/domain/background-tasks";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { useBackgroundOutput } from "../background-output.ts";
  import { useThreadDirectory } from "../thread-directory.ts";

  /**
   * The platform told the agent how background tasks of this thread ended (a turn of its own, or a note steered into
   * the running turn): one compact system entry per task, linking to its output. The note's full text is the agent's.
   */
  let { itemIds, class: className }: { itemIds: readonly string[]; class?: ClassValue } = $props();
  const directory = useThreadDirectory();
  const openOutput = useBackgroundOutput();

  interface Headline {
    title: string;
    outcome: string;
    command?: boolean;
  }

  function headline(id: string): Headline {
    const item = directory.item?.(id);

    if (item?.content.case !== "backgroundTask") return { title: id, outcome: "Background task ended" };
    const task = item.content.value;

    return {
      title: backgroundTitle(task, id),
      outcome: backgroundHeadline(backgroundOutcome(ItemStatus[item.status]), task.stopReason, task.exitCode),
      command: Boolean(task.command && (!task.description || task.description === task.command)),
    };
  }
</script>

<ul role="list" class={["flex min-w-0 flex-col gap-1", className]}>
  {#each itemIds as id (id)}
    {@const line = headline(id)}
    <li class="flex min-w-0 items-start gap-2 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      <span class="flex h-lh shrink-0 items-center"><Icon name="bolt" class="size-3.5" /></span>
      {#snippet content()}
        <p>{line.outcome}</p>
        <div class="flex min-w-0 items-center gap-2 text-zinc-700 dark:text-zinc-300">
          <p class={["min-w-0 flex-1 truncate", line.command && "font-mono"]}>{line.title}</p>
          {#if openOutput}<Icon name="chevron-right" class="size-3 shrink-0 text-zinc-400 dark:text-zinc-500" />{/if}
        </div>
      {/snippet}
      {#if openOutput}
        <button
          type="button"
          class="min-h-12 min-w-0 flex-1 rounded-sm text-left focus-ring hover:bg-zinc-950/4 sm:min-h-10 dark:hover:bg-white/5"
          aria-label="Open task output: {line.title}"
          onclick={() => openOutput(id)}>{@render content()}</button
        >
      {:else}
        <div class="min-w-0 flex-1">{@render content()}</div>
      {/if}
    </li>
  {/each}
</ul>

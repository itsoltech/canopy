<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { sideMark } from "#lib/features/threads/thread-tree.ts";
  import ThreadActivityMark from "#lib/features/threads/ThreadActivityMark.svelte";
  import ThreadGoalMark from "#lib/features/threads/ThreadGoalMark.svelte";
  import ThreadStatusText from "#lib/features/threads/ThreadStatusText.svelte";
  import SidebarThreadLink from "./SidebarThreadLink.svelte";
  import SwapText from "#lib/shared/ui/SwapText.svelte";

  /**
   * A side thread nested under its main thread in the inbox. Agent-started ones carry a violet mark, forks a
   * copy mark; while it works or waits, its activity mark takes that place; it steps back, stands out and
   * previews on hover like SidebarThread.
   */
  let { thread, current = false }: { thread: ui.Thread; current?: boolean } = $props();
  const mark = $derived(sideMark(thread));
</script>

<SidebarThreadLink {thread} {current} class="flex min-w-0 items-center gap-2 rounded-lg py-1.5 pr-3 pl-2">
  <ThreadActivityMark {thread} size="sm">
    {#snippet idle()}
      <Icon name={mark.icon} class={["size-3.5", mark.iconClass]} />
    {/snippet}
  </ThreadActivityMark>
  <SwapText text={thread.title} class={["h-6 min-w-0 flex-1 overflow-hidden text-base/6 sm:text-sm/6", thread.titleGenerating ? "shimmer" : "text-zinc-700 group-data-calm:opacity-60 group-data-result:text-zinc-950 group-aria-[current=page]:text-zinc-950 dark:text-zinc-300 dark:group-data-result:text-white dark:group-aria-[current=page]:text-white"]} />
  {#if thread.spawnedByAgent}<span class="sr-only">(started by an agent)</span>{/if}
  {#if thread.forkSourceThreadId}<span class="sr-only">(fork)</span>{/if}
  <ThreadGoalMark {thread} />
  <ThreadStatusText {thread} icons={false} class="group-data-calm:opacity-60" />
</SidebarThreadLink>

<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import ThreadStatusText from "#lib/features/threads/ThreadStatusText.svelte";

  /** A side thread nested under its main thread in the inbox. Agent-started ones carry a violet mark, forks a copy mark. */
  let { thread, current = false }: { thread: ui.Thread; current?: boolean } = $props();
</script>

<a
  href="/threads/{thread.id}"
  aria-current={current ? "page" : undefined}
  class="group flex min-w-0 items-center gap-2 rounded-lg py-1.5 pr-3 pl-2 hover:bg-zinc-950/4 focus-ring aria-[current=page]:bg-zinc-950/6 dark:hover:bg-white/4 dark:aria-[current=page]:bg-white/8"
>
  <Icon
    name={thread.spawnedByAgent ? "sparkles" : thread.forkSourceThreadId ? "square-2-stack" : "arrow-turn-down-right"}
    class={thread.spawnedByAgent ? "size-3.5 fill-violet-500 dark:fill-violet-400" : "size-3.5 fill-zinc-400 dark:fill-zinc-600"}
  />
  <span class="min-w-0 flex-1 truncate text-base/6 text-zinc-700 group-aria-[current=page]:text-zinc-950 sm:text-sm/6 dark:text-zinc-300 dark:group-aria-[current=page]:text-white">{thread.title}</span>
  {#if thread.spawnedByAgent}<span class="sr-only">(started by an agent)</span>{/if}
  {#if thread.forkSourceThreadId}<span class="sr-only">(fork)</span>{/if}
  <ThreadStatusText {thread} />
</a>

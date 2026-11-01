<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import { basename } from "#lib/shared/format.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import ProjectAvatar from "#lib/shared/ui/ProjectAvatar.svelte";
  import ThreadStatusText from "#lib/features/threads/ThreadStatusText.svelte";
  import ThreadWorkBadges from "#lib/features/threads/ThreadWorkBadges.svelte";

  /**
   * One thread in the inbox (T3 layout): project and status, title, then where it runs with its marks
   * (goal, background tasks, side threads, started by an agent). `sides` = number of side threads under it.
   */
  let {
    thread,
    project,
    worker,
    sides = 0,
    current = false,
  }: { thread: ui.Thread; project: ui.Project | undefined; worker: ui.Worker | undefined; sides?: number; current?: boolean } = $props();
</script>

<a
  href="/threads/{thread.id}"
  aria-current={current ? "page" : undefined}
  class="group grid gap-0.5 rounded-xl px-3 py-2.5 hover:bg-zinc-950/4 focus-ring aria-[current=page]:bg-zinc-950/6 dark:hover:bg-white/4 dark:aria-[current=page]:bg-white/8"
>
  <span class="flex min-w-0 items-center gap-2">
    <ProjectAvatar name={project?.name ?? "?"} />
    <span class="min-w-0 flex-1 truncate text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">{project?.name ?? "Unknown project"}</span>
    <ThreadStatusText {thread} />
  </span>
  <span class="truncate text-base/6 text-zinc-800 group-aria-[current=page]:text-zinc-950 sm:text-sm/6 dark:text-zinc-200 dark:group-aria-[current=page]:text-white">{thread.title}</span>
  <span class="flex min-w-0 items-center gap-1.5 text-sm/5 text-zinc-500 sm:text-xs/5">
    <Icon name="computer-desktop" class="size-3.5 {worker?.online ? 'fill-zinc-400 dark:fill-zinc-500' : 'fill-zinc-300 dark:fill-zinc-700'}" />
    <span class="min-w-0 flex-1 truncate">{worker?.name ?? "Unknown worker"}<span class="text-zinc-400 dark:text-zinc-600">{" · "}</span>{basename(thread.cwd)}</span>
    <span class="flex shrink-0 items-center gap-2">
      <ThreadWorkBadges {thread} />
      {#if sides > 0}<span class="flex items-center gap-0.5" title="{sides} side {sides === 1 ? 'thread' : 'threads'}"><Icon name="arrows-right-left" class="size-3.5" />{sides}</span>{/if}
      {#if thread.spawnedByAgent}<Icon name="sparkles" class="size-3.5 fill-violet-500 dark:fill-violet-400" label="Started by an agent" />{/if}
    </span>
  </span>
</a>

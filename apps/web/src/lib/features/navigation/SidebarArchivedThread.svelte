<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { formatAge, formatDateTime, isoDateTime } from "#lib/shared/format.ts";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import ProjectAvatar from "#lib/shared/ui/ProjectAvatar.svelte";
  import SidebarThreadLink from "./SidebarThreadLink.svelte";

  let { thread, current = false, class: className }: { thread: ui.Thread; current?: boolean; class?: ClassValue } = $props();
  const overview = useOverview();
  const when = $derived(thread.archivedAt ?? thread.lastActivityAt ?? thread.createdAt);
</script>

<div class={className} data-archived-row={thread.id}>
  <SidebarThreadLink {thread} {current} compact class="flex h-10 min-w-0 items-center gap-2 rounded-lg px-3 sm:h-9">
    <ProjectAvatar name={overview.project(thread.projectId)?.name ?? "?"} class="opacity-50" />
    <span class="min-w-0 flex-1 truncate text-base/6 text-zinc-500 group-aria-[current=page]:text-zinc-950 sm:text-sm/6 dark:text-zinc-400 dark:group-aria-[current=page]:text-white">{thread.title}</span>
    <time datetime={isoDateTime(when)} title={formatDateTime(when)} class="shrink-0 text-xs text-zinc-500 tabular-nums pointer-fine:group-hover/row:invisible pointer-fine:group-focus-within/row:invisible dark:text-zinc-400">{formatAge(when, clock.now)}</time>
  </SidebarThreadLink>
</div>

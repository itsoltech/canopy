<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { basename } from "#lib/shared/format.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import ProjectMark from "#lib/shared/ui/ProjectMark.svelte";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import { providerKeyOf } from "#lib/features/threads/providers.ts";
  import ThreadActivityMark from "#lib/features/threads/ThreadActivityMark.svelte";
  import ThreadGoalMark from "#lib/features/threads/ThreadGoalMark.svelte";
  import ThreadStatusText from "#lib/features/threads/ThreadStatusText.svelte";
  import SidebarThreadLink from "./SidebarThreadLink.svelte";
  import SwapText from "#lib/shared/ui/SwapText.svelte";
  import ScheduleOrigin from "#lib/features/schedules/ScheduleOrigin.svelte";
  import MachineBadge from "#lib/features/computers/MachineBadge.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { awayReason, lastSeen } from "#lib/features/computers/computers.ts";

  /**
   * One thread in the inbox (T3 layout): project and status, title, then where it runs with its marks
   * (goal, side threads, started by an agent) and the provider's mark. `sides` = number of side threads under it.
   * What it does leads the row (ThreadActivityMark in the avatar's place, background tasks with their count);
   * busy rows step back, finished unseen ones and those that need you stand out (SidebarThreadLink). Hover,
   * focus or tap-and-hold shows its summary (ThreadHoverCard).
   */
  let {
    thread,
    project,
    worker,
    sides = 0,
    current = false,
  }: {
    thread: ui.Thread;
    project: ui.Project | undefined;
    worker: ui.Worker | undefined;
    sides?: number;
    current?: boolean;
  } = $props();

  const provider = $derived(providerKeyOf(thread.provider));
  const overview = useOverview();
  const computer = $derived(overview.computer(thread.nodeId));
  const away = $derived(thread.nodeId ? awayReason(computer) : undefined);
  const providerName = $derived(provider === "CLAUDE" ? "Claude" : provider === "GROK" ? "Grok" : "Codex");
</script>

<SidebarThreadLink {thread} {current} class="grid gap-0.5 rounded-xl px-3 py-2.5">
  <span class="flex min-w-0 items-center gap-2">
    {#if away}
      <Icon name="link" class="shrink-0 fill-zinc-400 dark:fill-zinc-500" />
    {:else}
      <ThreadActivityMark {thread}>
        {#snippet idle()}<ProjectMark name={project?.name ?? "?"} kind={project?.kind} />{/snippet}
      </ThreadActivityMark>
    {/if}
    <span
      class="min-w-0 flex-1 truncate text-sm/5 text-zinc-500 group-data-calm:opacity-60 sm:text-xs/5 dark:text-zinc-400"
      >{project?.name ?? "Unknown project"}</span
    >
    {#if away}
      <span class="shrink-0" title={away}>{lastSeen(computer)}</span>
    {:else}
      <ThreadStatusText
        {thread}
        icons={false}
        class="group-data-calm:opacity-60 pointer-fine:group-focus-within/row:invisible pointer-fine:group-hover/row:invisible"
      />
    {/if}
  </span>
  <SwapText
    text={thread.title}
    class={[
      "h-6 w-full min-w-0 overflow-hidden text-base/6 sm:text-sm/6",
      thread.titleGenerating
        ? "shimmer"
        : "text-zinc-800 group-aria-[current=page]:text-zinc-950 group-data-calm:opacity-60 group-data-result:text-zinc-950 dark:text-zinc-200 dark:group-aria-[current=page]:text-white dark:group-data-result:text-white",
    ]}
  />
  <span class="flex min-w-0 items-center gap-1.5 text-sm/5 text-zinc-500 group-data-calm:opacity-60 sm:text-xs/5">
    <Icon
      name="computer-desktop"
      class="size-3.5 {worker?.online ? 'fill-zinc-400 dark:fill-zinc-500' : 'fill-zinc-300 dark:fill-zinc-700'}"
    />
    <span class="min-w-0 flex-1 truncate"
      >{worker?.name ?? "Unknown worker"}<span class="text-zinc-400 dark:text-zinc-600">{" · "}</span>{project?.kind ===
      "scratch"
        ? "scratch folder"
        : basename(thread.cwd)}</span
    >
    <MachineBadge nodeId={thread.nodeId} compact class="max-w-28" />
    <span class="flex shrink-0 items-center gap-2">
      <ThreadGoalMark {thread} />
      <ScheduleOrigin {thread} compact />
      {#if sides > 0}<span class="flex items-center gap-0.5" title="{sides} side {sides === 1 ? 'thread' : 'threads'}"
          ><Icon name="arrows-right-left" class="size-3.5" />{sides}</span
        >{/if}
      {#if thread.spawnedByAgent}<Icon
          name="sparkles"
          class="size-3.5 text-violet-500 dark:text-violet-400"
          label="Started by an agent"
        />{/if}
      {#if provider}<span
          class="flex"
          title={thread.providerProfileId ? `${providerName} · ${thread.providerProfileId}` : providerName}
          ><ProviderIcon {provider} label={providerName} class="size-3.5 opacity-70" /></span
        >{/if}
    </span>
  </span>
</SidebarThreadLink>

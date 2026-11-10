<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { sideMark } from "#lib/features/threads/thread-tree.ts";
  import ThreadActivityMark from "#lib/features/threads/ThreadActivityMark.svelte";
  import ThreadGoalMark from "#lib/features/threads/ThreadGoalMark.svelte";
  import SidebarThreadStatus from "./SidebarThreadStatus.svelte";
  import SidebarThreadLink from "./SidebarThreadLink.svelte";
  import SwapText from "#lib/shared/ui/SwapText.svelte";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import { providerKeyOf } from "#lib/features/threads/providers.ts";
  import { formatRelative, formatDateTime, isoDateTime } from "#lib/shared/format.ts";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import type { ClassValue } from "svelte/elements";

  /**
   * A side thread nested under its main thread in the inbox. Agent-started ones carry a violet mark, forks a
   * copy mark; while it works or waits, its activity mark takes that place; it steps back, stands out and
   * previews on hover like SidebarThread.
   */
  let {
    thread,
    current = false,
    previous = false,
    class: className,
  }: { thread: ui.Thread; current?: boolean; previous?: boolean; class?: ClassValue } = $props();

  const mark = $derived(sideMark(thread));
  const provider = $derived(providerKeyOf(thread.provider));
  const when = $derived(thread.archivedAt ?? thread.lastActivityAt ?? thread.createdAt);
</script>

<SidebarThreadLink
  {thread}
  {current}
  compact
  class={[
    "flex min-h-10 min-w-0 items-center gap-2 rounded-lg py-1.5 pr-3 pl-2 sm:min-h-9 pointer-coarse:min-h-12",
    thread.status === "archived" && "opacity-60",
    className,
  ]}
>
  {#if previous && provider}<ProviderIcon {provider} class="size-3.5 opacity-70" />{:else}
    <ThreadActivityMark {thread} size="sm" class="sidebar-row-activity-small">
      {#snippet idle()}
        <!-- An agent's side thread (subagent) shows what it runs on; forks and your own side threads their kind. -->
        {#if thread.spawnedByAgent && provider}<ProviderIcon {provider} class="size-3.5" />{:else}<Icon
            name={mark.icon}
            class={["size-3.5", mark.iconClass]}
          />{/if}
      {/snippet}
    </ThreadActivityMark>
  {/if}
  <SwapText
    text={thread.title}
    live={thread.titleGenerating}
    class={[
      "h-5.5 min-w-0 flex-1 overflow-hidden text-base/5.5 sm:h-5 sm:text-sm/5",
      thread.titleGenerating
        ? "text-zinc-500 dark:text-zinc-400"
        : "text-zinc-700 group-aria-[current=page]:text-zinc-950 group-data-calm:opacity-60 group-data-result:text-zinc-950 dark:text-zinc-300 dark:group-aria-[current=page]:text-white dark:group-data-result:text-white",
    ]}
  />
  {#if thread.spawnedByAgent}<span class="sr-only">(started by an agent)</span>{/if}
  {#if thread.forkSourceThreadId}<span class="sr-only">(fork)</span>{/if}
  {#if previous && when}<time
      datetime={isoDateTime(when)}
      title={formatDateTime(when)}
      class="w-24 shrink-0 truncate text-right text-sm/5 text-zinc-500 tabular-nums sm:text-xs/4.5 dark:text-zinc-400"
      >{formatRelative(when, clock.now)}</time
    >
  {:else}<ThreadGoalMark {thread} /><SidebarThreadStatus {thread} />{/if}
</SidebarThreadLink>

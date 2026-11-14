<script lang="ts">
  import DraftMarker from "#lib/features/drafts/DraftMarker.svelte";
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { formatRelative, isoDateTime } from "#lib/shared/format.ts";
  import { activityOf, needsYou } from "../activity.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { statusLook } from "#lib/shared/ui/status.ts";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import AgentBadge from "./AgentBadge.svelte";
  import ScheduleOrigin from "#lib/features/schedules/ScheduleOrigin.svelte";

  /**
   * A thread as a navigation row: live status, title, agent marker and waiting interactions.
   * `meta` adds a second line (worker, directory, age) for the project page.
   */
  let {
    thread,
    current = false,
    meta,
    class: className,
  }: { thread: ui.Thread; current?: boolean; meta?: string | undefined; class?: ClassValue } = $props();

  const look = $derived(statusLook(thread.status));
</script>

<a
  href="/threads/{thread.id}"
  aria-current={current ? "page" : undefined}
  class={[
    "group flex min-w-0 items-start gap-2.5 rounded-lg px-2 py-2 focus-ring hover:bg-zinc-950/5 aria-[current=page]:bg-zinc-950/5 sm:py-1.5 dark:hover:bg-white/5 dark:aria-[current=page]:bg-white/10",
    className,
  ]}
>
  <span class="flex h-lh items-center text-base/6 sm:text-sm/6"
    ><StatusDot tone={look.tone} active={look.active} /></span
  >
  <span class="min-w-0 flex-1">
    <span class="flex min-w-0 items-center gap-1.5 text-base/6 sm:text-sm/6">
      <span
        class="truncate text-zinc-700 group-aria-[current=page]:font-medium group-aria-[current=page]:text-zinc-950 dark:text-zinc-300 dark:group-aria-[current=page]:text-white"
        >{thread.title}</span
      >
      {#if thread.spawnedByAgent}<AgentBadge compact />{/if}
      <ScheduleOrigin {thread} compact />
      <span class="sr-only">({look.label})</span>
    </span>
    {#if meta}
      <span class="block truncate text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
        {meta}{#if activityOf(thread)}{" · "}<time datetime={isoDateTime(activityOf(thread))}
            >{formatRelative(activityOf(thread), clock.now)}</time
          >{/if}
      </span>
    {/if}
  </span>
  <div class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400"><DraftMarker threadId={thread.id} /></div>
  {#if needsYou(thread)}
    <span
      class="flex h-lh shrink-0 items-center gap-1 text-sm/5 font-medium text-amber-700 sm:text-xs/5 dark:text-amber-400"
    >
      <Icon name="hand-raised" tone="inherit" class="size-3.5" />{thread.pendingInteractions || ""}<span class="sr-only"
        >waiting for you</span
      >
    </span>
  {/if}
</a>

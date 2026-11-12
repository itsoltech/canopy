<script lang="ts">
  import { ItemStatus } from "@canopy/contracts";
  import { timestampFromMs } from "@bufbuild/protobuf/wkt";
  import type { ClassValue } from "svelte/elements";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { formatAge, formatRelative, formatSpan, formatLocalDateTime } from "#lib/shared/format.ts";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import LiveTime from "#lib/shared/ui/LiveTime.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { backgroundName, backgroundStatus, backgroundTimes, type BackgroundEntry } from "../background-tasks.ts";
  import BackgroundTaskStop from "./BackgroundTaskStop.svelte";

  let {
    entry,
    threadId,
    exitCode,
    onclick,
    class: className,
  }: {
    entry: BackgroundEntry;
    threadId: string;
    exitCode?: number | undefined;
    onclick: () => void;
    class?: ClassValue;
  } = $props();

  const task = $derived(entry.item.content.value);
  const running = $derived(entry.item.status === ItemStatus.IN_PROGRESS);
  const failed = $derived(entry.item.status === ItemStatus.FAILED || task.stopReason === "error");
  const stopped = $derived(entry.item.status === ItemStatus.INTERRUPTED || (!!task.stopReason && !failed));
  const status = $derived(backgroundStatus(entry, exitCode).replace(/^Done/, "Completed"));
  const times = $derived(backgroundTimes(entry));
  const ended = $derived(!running && times.endedAt !== undefined ? timestampFromMs(times.endedAt) : undefined);
  const age = $derived(ended ? formatAge(ended, clock.now) : "");
  const hasDuration = $derived(times.startedAt !== undefined && (running || times.endedAt !== undefined));

  const elapsed = (now: number) =>
    times.startedAt !== undefined ? formatSpan(Math.max(0, (times.endedAt ?? now) - times.startedAt)) : "";
</script>

<div
  class={[
    "task-row relative min-w-0 rounded-lg has-focus-visible:bg-zinc-950/4 has-[button:hover]:bg-zinc-950/4 dark:has-focus-visible:bg-white/5 dark:has-[button:hover]:bg-white/5",
    className,
  ]}
>
  <button
    type="button"
    class="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left text-base/5 text-zinc-700 focus-ring sm:min-h-8 sm:text-sm/5 dark:text-zinc-300"
    aria-label="{backgroundName(task)} — {status}. Show full output"
    {onclick}
    {@attach tooltip(`${backgroundName(task)} — ${status}`)}
  >
    <span class="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
      {#if running}<StatusDot tone="sky" pulse />
      {:else if failed}<Icon name="exclamation-circle" class="text-rose-700 dark:text-rose-400" />
      {:else if stopped}<Icon name="stop" class="text-zinc-500 dark:text-zinc-400" />
      {:else if entry.item.status === ItemStatus.COMPLETED}<Icon
          name="check-circle"
          class="text-emerald-700 dark:text-emerald-400"
        />
      {:else}<StatusDot tone="neutral" />{/if}
    </span>
    <span class={["min-w-0 flex-1 truncate", !task.description && task.command && "font-mono"]}
      >{backgroundName(task)}</span
    >
    <span
      class={[
        "task-metadata flex shrink-0 items-center justify-end gap-1 text-sm/5 whitespace-nowrap text-zinc-500 tabular-nums sm:text-xs/5 dark:text-zinc-400",
        running && "task-running-time min-w-7 pr-8",
      ]}
    >
      {#if hasDuration}<LiveTime format={elapsed} active={running} label="Duration" />{/if}
      {#if ended}
        {#if hasDuration}<span aria-hidden="true">·</span>{/if}
        <time
          datetime={new Date(times.endedAt ?? 0).toISOString()}
          aria-label="Ended {formatRelative(ended, clock.now)}"
          title={formatLocalDateTime(new Date(times.endedAt ?? 0))}>{age === "now" ? "now" : `${age} ago`}</time
        >
      {/if}
    </span>
  </button>
  {#if running}
    <div class="task-stop absolute inset-y-0 right-1 flex items-center">
      <BackgroundTaskStop {threadId} itemId={entry.id} compact />
    </div>
  {/if}
</div>

<style>
  /* Fine pointers use the sidebar's time/action swap. Touch keeps Stop beside the elapsed time. */
  @media (hover: hover) and (pointer: fine) {
    .task-running-time {
      padding-right: 0;
    }

    .task-stop {
      visibility: hidden;
      pointer-events: none;
      opacity: 0;
      scale: var(--scale-large);
      filter: blur(var(--blur-small));
    }

    .task-stop,
    .task-running-time {
      transition:
        opacity var(--duration-fast) var(--ease-in-out),
        scale var(--duration-fast) var(--ease-in-out),
        filter var(--duration-fast) var(--ease-in-out),
        visibility 0s linear var(--duration-fast);
    }

    .task-row:is(:hover, :focus-within) .task-stop {
      visibility: visible;
      pointer-events: auto;
      opacity: 1;
      scale: 1;
      filter: blur(0);
      transition-delay: 0s;
    }

    .task-row:is(:hover, :focus-within) .task-running-time {
      opacity: 0;
      scale: var(--scale-large);
      filter: blur(var(--blur-small));
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .task-stop,
    .task-running-time {
      transition: none;
    }
  }
</style>

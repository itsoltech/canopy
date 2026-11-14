<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { scheduleRunLabel } from "@canopy/domain/schedule-display";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { dayKey, formatDay, formatTime, formatDateTime } from "#lib/shared/format.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";

  let {
    runs,
    threadId = "",
    class: className,
  }: { runs: readonly ui.ScheduleRun[]; threadId?: string; class?: ClassValue } = $props();

  const overview = useOverview();

  const rowClass = "flex min-w-0 items-start gap-1.5 rounded px-2 py-1 text-sm/5 tabular-nums pointer-coarse:min-h-10";
</script>

<ul role="list" class={["min-w-0 text-zinc-500 dark:text-zinc-400", className]}>
  {#each runs as run, index (`${run.scheduledFor?.seconds}:${run.scheduledFor?.nanos}`)}
    <li class="min-w-0">
      {#if index === 0 || dayKey(run.scheduledFor) !== dayKey(runs[index - 1]?.scheduledFor)}
        <p class="px-2 py-1 font-medium">{formatDay(run.scheduledFor)}</p>
      {/if}
      {#snippet content()}
        <span
          class="flex h-lh items-center"
          title={scheduleRunLabel(run.outcome)}
          aria-label={scheduleRunLabel(run.outcome)}
        >
          <Icon
            name={run.outcome === "started" ? "play" : "exclamation-circle"}
            class={["size-3.5 shrink-0", run.outcome !== "started" && "text-amber-600 dark:text-amber-400"]}
          />
        </span>
        <div class="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1">
          <span class="min-w-0">{run.number ? `Run ${run.number}` : scheduleRunLabel(run.outcome)}</span>
          <span class="shrink-0">· {formatTime(run.scheduledFor)}</span>
          {#if run.workerId}<span class="max-w-36 truncate"
              >· {overview.worker(run.workerId)?.name ?? "Computer unavailable"}</span
            >{/if}
          {#if run.threadId && run.threadId !== threadId}<span
              class="min-w-0 basis-full truncate @xl:flex-1 @xl:basis-auto"
              >· {overview.threads.get(run.threadId)?.title ?? "Open thread"}</span
            >{/if}
          {#if run.number && run.outcome !== "started"}<span class="min-w-0 truncate"
              >· {scheduleRunLabel(run.outcome)}</span
            >{/if}
        </div>
      {/snippet}
      {#if run.threadId}
        <a
          href="/threads/{run.threadId}"
          class={[rowClass, "focus-ring hover:bg-zinc-950/5 dark:hover:bg-white/5"]}
          title={formatDateTime(run.scheduledFor)}>{@render content()}</a
        >
      {:else}<div class={rowClass}>{@render content()}</div>{/if}
    </li>
  {/each}
</ul>

<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { formatDateTime } from "#lib/shared/format.ts";
  let { runs, class: className }: { runs: readonly ui.ScheduleRun[]; class?: ClassValue } = $props();
  const overview = useOverview();
  const outcomes: Record<string, string> = { missed: "Missed", running: "Skipped · previous run working", expired: "Expired" };
</script>

<div class={["grid gap-2 text-base/6 sm:text-sm/5", className]}>
  <p class="font-medium text-zinc-600 dark:text-zinc-300">Recent runs</p>
  <ul role="list" class="grid gap-1.5 text-zinc-500 dark:text-zinc-400">
    {#each runs as run (run.scheduledFor?.seconds)}
      <li class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 tabular-nums">
        {#if run.threadId}
          <a href="/threads/{run.threadId}" class="min-w-0 truncate font-medium text-zinc-700 underline decoration-zinc-950/15 underline-offset-2 hover:text-zinc-950 focus-ring dark:text-zinc-300 dark:decoration-white/20 dark:hover:text-white">Run {run.number} · {overview.threads.get(run.threadId)?.title ?? "Open thread"}</a>
          <span>· {overview.worker(run.workerId)?.name ?? "Worker"}</span>
        {:else}<span>{outcomes[run.outcome] ?? run.outcome}</span>{/if}
        {#if run.scheduledFor}<span>· {formatDateTime(run.scheduledFor)}</span>{/if}
      </li>
    {/each}
  </ul>
</div>

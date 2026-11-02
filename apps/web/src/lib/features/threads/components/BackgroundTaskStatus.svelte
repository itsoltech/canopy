<script lang="ts">
  import { ItemStatus } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { formatSpan } from "#lib/shared/format.ts";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import { backgroundStatus, type BackgroundEntry } from "../background-tasks.ts";

  let { entry, exitCode, class: className }: { entry: BackgroundEntry; exitCode?: number | undefined; class?: ClassValue } = $props();
  let now = $state(Date.now());
  const running = $derived(entry.item.status === ItemStatus.IN_PROGRESS);
  $effect(() => {
    if (!running) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const elapsed = $derived(entry.startedAt !== undefined && (running || entry.completedAt !== undefined) ? formatSpan(Math.max(0, (entry.completedAt ?? now) - entry.startedAt)) : "Time unavailable");
</script>

<span class={["flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400", className]}>
  <StatusDot tone={running ? "sky" : entry.item.status === ItemStatus.FAILED ? "rose" : entry.item.status === ItemStatus.COMPLETED ? "emerald" : "neutral"} class={running ? "t-pulse" : undefined} />
  <span>{backgroundStatus(entry, exitCode).replace(/^Done/, "Completed")}</span><span aria-hidden="true">·</span><span class="tabular-nums">{elapsed}</span>
</span>

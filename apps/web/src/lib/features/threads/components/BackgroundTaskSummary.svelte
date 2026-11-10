<script lang="ts">
  import { ItemStatus } from "@canopy/contracts";
  import { timestampFromMs } from "@bufbuild/protobuf/wkt";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { formatAge, formatRelative, formatSpan, formatLocalDateTime } from "#lib/shared/format.ts";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import LiveTime from "#lib/shared/ui/LiveTime.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { backgroundName, backgroundStatus, backgroundTimes, type BackgroundEntry } from "../background-tasks.ts";
  import type { ClassValue } from "svelte/elements";

  let {
    entry,
    exitCode,
    class: className,
  }: {
    entry: BackgroundEntry;
    exitCode?: number | undefined;
    class?: ClassValue;
  } = $props();

  const task = $derived(entry.item.content.value);
  const running = $derived(entry.item.status === ItemStatus.IN_PROGRESS);

  const failed = $derived(entry.item.status === ItemStatus.FAILED || task.stopReason === "error");
  const stopped = $derived(entry.item.status === ItemStatus.INTERRUPTED || (!!task.stopReason && !failed));
  const code = $derived(exitCode ?? task.exitCode);
  const status = $derived(backgroundStatus(entry, exitCode).replace(/^Done/, "Completed"));
  const times = $derived(backgroundTimes(entry));
  const ended = $derived(!running && times.endedAt !== undefined ? timestampFromMs(times.endedAt) : undefined);

  const elapsed = (now: number) =>
    times.startedAt !== undefined && (running || times.endedAt !== undefined)
      ? formatSpan(Math.max(0, (times.endedAt ?? now) - times.startedAt))
      : "–";
</script>

<span class={["flex min-w-0 items-center gap-1.5", className]} {@attach tooltip(`${backgroundName(task)} — ${status}`)}>
  <StatusDot
    tone={running
      ? "sky"
      : failed
        ? "rose"
        : stopped
          ? "neutral"
          : entry.item.status === ItemStatus.COMPLETED
            ? "emerald"
            : "neutral"}
    pulse={running}
  />
  <span class="sr-only">{status}:</span>
  <span class={["min-w-0 flex-1 truncate", !task.description && task.command && "font-mono"]}
    >{backgroundName(task)}</span
  >
  <span class="flex shrink-0 items-center gap-1 text-sm/5 text-zinc-500 tabular-nums sm:text-xs/5 dark:text-zinc-400">
    {#if failed}<span class="text-rose-700 dark:text-rose-400">Failed{code !== undefined ? ` (${code})` : ""}</span>
    {:else if stopped}<span>Stopped{code ? ` (${code})` : ""}</span>
    {:else if code}<span>exit {code}</span>{/if}
    <LiveTime
      format={elapsed}
      active={running}
      label={times.startedAt !== undefined && (running || times.endedAt !== undefined) ? "Duration" : undefined}
      class="min-w-[6ch] text-right"
    />
    <span class="w-[4ch] text-right">
      {#if ended}<time
          datetime={new Date(times.endedAt ?? 0).toISOString()}
          aria-label="Ended {formatRelative(ended, clock.now)}"
          title={formatLocalDateTime(new Date(times.endedAt ?? 0))}>{formatAge(ended, clock.now)}</time
        >{/if}
    </span>
  </span>
</span>

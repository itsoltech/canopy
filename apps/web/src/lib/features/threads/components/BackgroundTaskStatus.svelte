<script lang="ts">
  import { ItemStatus } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { timestampFromMs } from "@bufbuild/protobuf/wkt";
  import { formatRelative, formatSpan, formatLocalDateTime } from "#lib/shared/format.ts";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import LiveTime from "#lib/shared/ui/LiveTime.svelte";
  import { backgroundStatus, backgroundTimes, type BackgroundEntry } from "../background-tasks.ts";

  let {
    entry,
    exitCode,
    class: className,
  }: { entry: BackgroundEntry; exitCode?: number | undefined; class?: ClassValue } = $props();

  const running = $derived(entry.item.status === ItemStatus.IN_PROGRESS);

  const times = $derived(backgroundTimes(entry));

  const elapsed = (now: number) =>
    times.startedAt !== undefined && (running || times.endedAt !== undefined)
      ? formatSpan(Math.max(0, (times.endedAt ?? now) - times.startedAt))
      : "Time unavailable";

  // When it ended (e.g. stopped by a worker restart while nobody watched).
  const ended = $derived(!running && times.endedAt !== undefined ? timestampFromMs(times.endedAt) : undefined);
</script>

<span
  class={[
    "flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400",
    className,
  ]}
>
  <StatusDot
    tone={running
      ? "sky"
      : entry.item.status === ItemStatus.FAILED
        ? "rose"
        : entry.item.status === ItemStatus.COMPLETED
          ? "emerald"
          : "neutral"}
    pulse={running}
  />
  <span>{backgroundStatus(entry, exitCode).replace(/^Done/, "Completed")}</span><span aria-hidden="true">·</span
  ><LiveTime format={elapsed} active={running} class="tabular-nums" />
  {#if ended}<span aria-hidden="true">·</span><time
      class="tabular-nums"
      datetime={new Date(times.endedAt ?? 0).toISOString()}
      title={formatLocalDateTime(new Date(times.endedAt ?? 0))}>ended {formatRelative(ended)}</time
    >{/if}
</span>

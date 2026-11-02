<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import { timestampMs } from "@bufbuild/protobuf/wkt";
  import type { ClassValue } from "svelte/elements";
  import { formatDuration } from "#lib/shared/format.ts";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import { forkable } from "../fork-point.ts";
  import { useThreadDirectory } from "../thread-directory.ts";
  import type { TurnResult } from "../thread-state.svelte.ts";
  import ForkButton from "./ForkButton.svelte";

  /**
   * The quiet line under an ended turn (`t-quiet`: shown by a `data-shown` ancestor, see turn-reveal):
   * "Copy answer" (`answer`: the turn's last agent message), "Fork from here" (a new thread with the history up
   * to this ended turn) and how long the turn ran. Model, effort, permission mode and tokens are not repeated
   * per turn (the thread panel shows them). One line, so showing it moves nothing; on touch screens it stays visible.
   */
  let { turn, answer, class: className }: { turn: ui.Turn; result?: TurnResult | undefined; answer: string; class?: ClassValue } = $props();
  const took = $derived(turn.startedAt && turn.completedAt ? timestampMs(turn.completedAt) - timestampMs(turn.startedAt) : undefined);
  const directory = useThreadDirectory();
  const canFork = $derived(Boolean(directory.canFork && directory.currentId) && forkable(turn));
</script>

<div class={["-ml-2 flex min-h-8 items-center gap-x-2 text-sm/5 sm:-ml-1.5 sm:min-h-7 sm:text-xs/5", className]} role="group" aria-label="Turn details">
  {#if turn.status === "completed"}<span class="sr-only">Completed</span>{/if}
  <div class="flex min-w-0 items-center t-quiet t-quiet-touch">
    {#if answer}<CopyButton text={answer} label="Copy answer" />{/if}
    {#if canFork}<ForkButton threadId={directory.currentId} turnId={turn.id} />{/if}
    {#if took !== undefined && took >= 0}<span class="shrink-0 pl-1.5 text-zinc-500 tabular-nums dark:text-zinc-400" title="Time the turn ran">{formatDuration(took)}</span>{/if}
  </div>
</div>

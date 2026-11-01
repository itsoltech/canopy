<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import { formatDateTime, isoDateTime } from "#lib/shared/format.ts";
  import { triggerLabel } from "../labels.ts";

  /** Boundary before a turn: number, who started it (when not you) and when it was queued. */
  let { turn }: { turn: ui.Turn } = $props();
  const trigger = $derived(triggerLabel(turn.trigger));
</script>

<div class="flex items-center gap-3 pt-4 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
  <span class="font-medium text-zinc-700 tabular-nums dark:text-zinc-300">Turn {turn.ordinal}</span>
  {#if trigger}<span class={turn.trigger === "agent_bus" ? "text-violet-700 dark:text-violet-400" : undefined}>{trigger}</span>{/if}
  {#if turn.queuedAt}<time datetime={isoDateTime(turn.queuedAt)} class="max-sm:hidden">{formatDateTime(turn.queuedAt)}</time>{/if}
  <span class="h-px flex-1 bg-zinc-950/5 dark:bg-white/10"></span>
</div>

<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import { formatDateTime, isoDateTime } from "#lib/shared/format.ts";
  import { silentTriggerLabel } from "../turn-origin.ts";

  /**
   * Boundary before a turn: number, when it started (or was queued) and, for turns without an input
   * (provider wake-up, recovery), what started it. Inputs show their own origin below.
   */
  let { turn }: { turn: ui.Turn } = $props();
  const label = $derived(silentTriggerLabel(turn));
  const at = $derived(turn.startedAt ?? turn.queuedAt);
</script>

<div class="flex items-center gap-3 pt-4 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
  <span class="font-medium text-zinc-700 tabular-nums dark:text-zinc-300">Turn {turn.ordinal}</span>
  {#if label}<span>{label}</span>{/if}
  {#if at}<time datetime={isoDateTime(at)} class="max-sm:hidden">{formatDateTime(at)}</time>{/if}
  <span class="h-px flex-1 bg-zinc-950/5 dark:bg-white/10"></span>
</div>

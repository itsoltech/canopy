<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import { formatCount } from "#lib/shared/format.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import { statusLook } from "#lib/shared/ui/status.ts";
  import { textTones } from "#lib/shared/ui/tone.ts";
  import type { TurnResult } from "../thread-state.svelte.ts";

  /** How a turn ended, with token usage when this tab saw the turn finish. */
  let { turn, result }: { turn: ui.Turn; result: TurnResult | undefined } = $props();

  const look = $derived(statusLook(turn.status));
  const icon = $derived<IconName>(turn.status === "completed" ? "check-circle" : turn.status === "failed" ? "x-circle" : turn.status === "interrupted" ? "stop" : "minus");
  const reasons: Record<string, string> = { user: "by you", drain: "worker draining", worker_restart: "worker restarted" };
  const detail = $derived(turn.error || (result?.reason ? (reasons[result.reason] ?? result.reason) : ""));
  const usage = $derived(result?.usage);
</script>

<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm/5 sm:text-xs/5">
  <span class={["flex items-center gap-1 font-medium", textTones[look.tone]]}><Icon name={icon} class="size-3.5" />{look.label}</span>
  {#if detail}<span class={turn.status === "failed" ? "text-rose-700 dark:text-rose-400" : "text-zinc-500 dark:text-zinc-400"}>{detail}</span>{/if}
  {#if usage && (usage.inputTokens > 0n || usage.outputTokens > 0n)}
    <span class="text-zinc-500 tabular-nums dark:text-zinc-400" title="Input tokens (cached) · output tokens">
      {formatCount(usage.inputTokens)} in{usage.cachedInputTokens > 0n ? ` (${formatCount(usage.cachedInputTokens)} cached)` : ""} · {formatCount(usage.outputTokens)} out{usage.costUsd > 0 ? ` · $${usage.costUsd.toFixed(3)}` : ""}
    </span>
  {/if}
</div>

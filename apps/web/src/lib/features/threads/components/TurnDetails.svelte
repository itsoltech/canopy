<script lang="ts">
  import { PermissionMode, type ui } from "@open-agents/contracts";
  import { timestampMs } from "@bufbuild/protobuf/wkt";
  import type { ClassValue } from "svelte/elements";
  import { effortLevel, nameOfModel } from "#lib/features/models/catalog.ts";
  import { useModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import { formatCount, formatDuration } from "#lib/shared/format.ts";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { forkable } from "../fork-point.ts";
  import { permissionLabel, permissionLook } from "../labels.ts";
  import { useThreadDirectory } from "../thread-directory.ts";
  import type { TurnResult } from "../thread-state.svelte.ts";
  import { turnReveal } from "../turn-reveal.svelte.ts";
  import ForkButton from "./ForkButton.svelte";

  /**
   * The quiet line under an ended turn (`t-quiet`: shown by a `data-shown` ancestor, see turn-reveal):
   * "Copy answer" (`answer`: the turn's last agent message), "Fork from here" (a new thread with the history up
   * to this ended turn, opened once created), how long the turn ran, the model and effort
   * it ran with (empty = the profile's defaults, not shown), its permission mode (full auto in amber;
   * turns from before modes were recorded show none) and its token usage (kept with the turn). It keeps
   * one line, so showing it moves nothing; on touch screens "Copy answer", "Fork from here" and a details button stay
   * visible, and the button opens the rest (it may wrap then).
   */
  let { turn, result, answer, class: className }: { turn: ui.Turn; result: TurnResult | undefined; answer: string; class?: ClassValue } = $props();
  const models = useModelCatalog();
  const ranWith = $derived([turn.model ? nameOfModel(turn.model, models.workers.values()) : "", turn.effort ? effortLevel(turn.effort).label : ""].filter(Boolean).join(" · "));
  const ranWithIds = $derived([turn.model, turn.effort].filter(Boolean).join(" · "));
  const usage = $derived(turn.usage ?? result?.usage);
  const hasUsage = $derived(Boolean(usage && (usage.inputTokens > 0n || usage.outputTokens > 0n)));
  const took = $derived(turn.startedAt && turn.completedAt ? timestampMs(turn.completedAt) - timestampMs(turn.startedAt) : undefined);
  const details = $derived((took !== undefined && took >= 0) || Boolean(ranWith) || turn.permissionMode !== PermissionMode.UNSPECIFIED || hasUsage);
  const pinned = $derived(turnReveal.pinned.has(turn.id));
  const directory = useThreadDirectory();
  const canFork = $derived(Boolean(directory.canFork && directory.currentId) && forkable(turn));
</script>

<div class={["-ml-2 flex min-h-8 items-center gap-x-2 text-sm/5 sm:-ml-1.5 sm:min-h-7 sm:text-xs/5", className]} role="group" aria-label="Turn details">
  {#if turn.status === "completed"}<span class="sr-only">Completed</span>{/if}
  {#if answer || canFork || details}
    <div class="flex shrink-0 items-center t-quiet t-quiet-touch">
      {#if answer}<CopyButton text={answer} label="Copy answer" />{/if}
      {#if canFork}<ForkButton threadId={directory.currentId} turnId={turn.id} />{/if}
      {#if details}
        <IconButton
          icon="information-circle"
          size="sm"
          label={pinned ? "Hide turn details" : "Show turn details"}
          aria-expanded={pinned}
          class="[@media(hover:hover)]:hidden"
          onclick={() => turnReveal.toggle(turn.id)}
        />
      {/if}
    </div>
  {/if}
  <div class={["flex min-w-0 items-center gap-x-3 gap-y-1 pl-1.5 text-zinc-500 t-quiet dark:text-zinc-400", pinned ? "flex-wrap" : "overflow-hidden"]}>
    {#if took !== undefined && took >= 0}<span class="shrink-0 tabular-nums" title="Time the turn ran">{formatDuration(took)}</span>{/if}
    {#if ranWith}<span class="min-w-0 truncate" title="Model and reasoning effort: {ranWithIds}">{ranWith}</span>{/if}
    {#if turn.permissionMode !== PermissionMode.UNSPECIFIED}
      {@const look = permissionLook(turn.permissionMode)}
      <span class={["flex shrink-0 items-center gap-1", look.textClass]} title="Permission mode the turn ran with">
        <Icon name={look.icon} class={["size-3.5", look.iconClass]} />{permissionLabel(turn.permissionMode)}
      </span>
    {/if}
    {#if hasUsage && usage}
      <span class="shrink-0 tabular-nums" title="Input tokens (cached) · output tokens">
        {formatCount(usage.inputTokens)} in{usage.cachedInputTokens > 0n ? ` (${formatCount(usage.cachedInputTokens)} cached)` : ""} · {formatCount(usage.outputTokens)} out{usage.costUsd > 0 ? ` · $${usage.costUsd.toFixed(3)}` : ""}
      </span>
    {/if}
  </div>
</div>

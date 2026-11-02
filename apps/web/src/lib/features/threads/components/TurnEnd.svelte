<script lang="ts">
  import { PermissionMode, type ui } from "@open-agents/contracts";
  import { timestampMs } from "@bufbuild/protobuf/wkt";
  import { effortLevel, nameOfModel } from "#lib/features/models/catalog.ts";
  import { useModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import { formatCount, formatDuration } from "#lib/shared/format.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import { statusLook } from "#lib/shared/ui/status.ts";
  import { textTones } from "#lib/shared/ui/tone.ts";
  import { sendMessage } from "../api.ts";
  import { isFullAuto, permissionLabel } from "../labels.ts";
  import { useThreadDirectory } from "../thread-directory.ts";
  import type { TurnResult } from "../thread-state.svelte.ts";

  /**
   * How a turn ended: status, who interrupted it or where its error came from (the platform or the
   * harness) with the reason, how long it ran, the model and effort it ran with (empty = the profile's
   * defaults, not shown), its permission mode (full auto in amber; turns from before modes were recorded
   * show none) and its token usage (kept with the turn). A turn the system interrupted (e.g. the
   * worker restarted mid-turn) can be continued: a short message resumes the harness session.
   */
  let { turn, result }: { turn: ui.Turn; result: TurnResult | undefined } = $props();
  const directory = useThreadDirectory();
  const models = useModelCatalog();
  const ranWith = $derived([turn.model ? nameOfModel(turn.model, models.workers.values()) : "", turn.effort ? effortLevel(turn.effort).label : ""].filter(Boolean).join(" · "));
  const ranWithIds = $derived([turn.model, turn.effort].filter(Boolean).join(" · "));

  const look = $derived(statusLook(turn.status));
  const icon = $derived<IconName>(turn.status === "completed" ? "check-circle" : turn.status === "failed" ? "x-circle" : turn.status === "interrupted" ? "stop" : "minus");
  const reasons: Record<string, string> = { user: "by you", interrupted: "by you", drain: "worker draining", worker_restart: "worker restarted" };
  const reason = $derived(turn.interruptReason || result?.reason || "");
  const detail = $derived.by(() => {
    if (turn.status === "failed") {
      const where = turn.errorSource === "harness" ? "Harness error" : turn.errorSource === "platform" ? "Platform error" : "";
      return [where, turn.error].filter(Boolean).join(": ");
    }
    if (turn.status === "interrupted" && turn.interruptSource === "system") return `by the system: ${reasons[reason] ?? (reason || "unknown reason")}`;
    if (turn.status === "interrupted" && turn.interruptSource === "user") return reason && reason !== "interrupted" && reason !== "user" ? `by you: ${reason}` : "by you";
    return reason ? (reasons[reason] ?? reason) : "";
  });
  const canContinue = $derived(turn.status === "interrupted" && turn.interruptSource === "system" && !turn.inherited && Boolean(directory.currentId));
  let continuing = $state<"idle" | "sending" | "sent" | "error">("idle");
  // One key per footer: a retry after a network error does not queue the continuation twice.
  const continueRequest = crypto.randomUUID();
  async function continueTurn() {
    if (continuing === "sending" || continuing === "sent") return;
    continuing = "sending";
    try {
      await sendMessage(
        directory.currentId,
        `Continue where you left off. Your previous turn was interrupted by the system (${reason || "unknown reason"}), not by me. Check what was already done before repeating anything with side effects.`,
        continueRequest,
      );
      continuing = "sent";
    } catch {
      continuing = "error";
    }
  }
  const usage = $derived(turn.usage ?? result?.usage);
  const took = $derived(turn.startedAt && turn.completedAt ? timestampMs(turn.completedAt) - timestampMs(turn.startedAt) : undefined);
</script>

<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm/5 sm:text-xs/5">
  <span class={["flex items-center gap-1 font-medium", textTones[look.tone]]}><Icon name={icon} class="size-3.5" />{look.label}</span>
  {#if detail}<span class={turn.status === "failed" ? "text-rose-700 dark:text-rose-400" : "text-zinc-500 dark:text-zinc-400"} title={turn.errorCode ? `Error code: ${turn.errorCode}` : undefined}>{detail}</span>{/if}
  {#if canContinue}
    <button
      type="button"
      class="font-medium text-sky-700 hover:underline disabled:opacity-60 disabled:hover:no-underline dark:text-sky-400"
      disabled={continuing === "sending" || continuing === "sent"}
      title="Send a message that resumes the harness session with full context"
      onclick={continueTurn}
    >
      {continuing === "sent" ? "Continuation queued" : continuing === "sending" ? "Continuing…" : continuing === "error" ? "Continue (retry)" : "Continue"}
    </button>
  {/if}
  {#if took !== undefined && took >= 0}<span class="text-zinc-500 tabular-nums dark:text-zinc-400" title="Time the turn ran">{formatDuration(took)}</span>{/if}
  {#if ranWith}<span class="min-w-0 truncate text-zinc-500 dark:text-zinc-400" title="Model and reasoning effort: {ranWithIds}">{ranWith}</span>{/if}
  {#if turn.permissionMode !== PermissionMode.UNSPECIFIED}
    {@const fullAuto = isFullAuto(turn.permissionMode)}
    <span class={["flex shrink-0 items-center gap-1", fullAuto ? "text-amber-700 dark:text-amber-400" : "text-zinc-500 dark:text-zinc-400"]} title="Permission mode the turn ran with">
      <Icon name={fullAuto ? "shield-exclamation" : "shield-check"} class={["size-3.5", fullAuto ? "fill-amber-600 dark:fill-amber-400" : "fill-zinc-400 dark:fill-zinc-500"]} />{permissionLabel(turn.permissionMode)}
    </span>
  {/if}
  {#if usage && (usage.inputTokens > 0n || usage.outputTokens > 0n)}
    <span class="text-zinc-500 tabular-nums dark:text-zinc-400" title="Input tokens (cached) · output tokens">
      {formatCount(usage.inputTokens)} in{usage.cachedInputTokens > 0n ? ` (${formatCount(usage.cachedInputTokens)} cached)` : ""} · {formatCount(usage.outputTokens)} out{usage.costUsd > 0 ? ` · $${usage.costUsd.toFixed(3)}` : ""}
    </span>
  {/if}
</div>

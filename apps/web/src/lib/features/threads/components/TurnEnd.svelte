<script lang="ts">
  import { humanizeEnum, isEnumToken } from "@canopy/domain/humanize";
  import type { ui } from "@canopy/contracts";
  import { Provider, ProviderProfileKind } from "@canopy/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import FailureNotice from "#lib/features/failures/FailureNotice.svelte";
  import ThreadModelDialog from "./ThreadModelDialog.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import { statusLook } from "#lib/shared/ui/status.ts";
  import { textTones } from "#lib/shared/ui/tone.ts";
  import { sendMessage } from "../api.ts";
  import { useThreadDirectory } from "../thread-directory.ts";
  import type { TurnResult } from "../thread-state.svelte.ts";
  import { turnReveal } from "../turn-reveal.svelte.ts";
  import TurnDetails from "./TurnDetails.svelte";

  /**
   * How a turn ended. A turn that did not complete always shows its status, who interrupted it or where
   * its error came from (the platform or the harness) with the reason; one the system interrupted (e.g.
   * the worker restarted mid-turn) can be continued: a short message resumes the harness session.
   * "Completed" is the norm, so it is not shown. The rest is quiet (TurnDetails), revealed with the turn
   * (turn-reveal).
   */
  let { turn, result, answer }: { turn: ui.Turn; result: TurnResult | undefined; answer: string } = $props();
  const directory = useThreadDirectory();
  const overview = useOverview();
  const thread = $derived(directory.thread(directory.currentId));
  const worker = $derived(thread ? overview.worker(thread.workerId) : undefined);

  const proxy = $derived(
    worker?.providerInstances.some(
      (instance) =>
        instance.harness === thread?.provider &&
        instance.id === (thread.providerProfileId || "native") &&
        instance.kind === ProviderProfileKind.CLIPROXYAPI,
    ) ?? false,
  );

  const providerHref = $derived(
    thread
      ? `/settings/providers?instance=${Provider[thread.provider]}:${encodeURIComponent(thread.providerProfileId || "native")}&worker=${encodeURIComponent(thread.workerId)}`
      : "/settings/providers",
  );

  let modelOpen = $state(false);

  const look = $derived(statusLook(turn.status));

  const icon = $derived<IconName>(
    turn.status === "completed"
      ? "check-circle"
      : turn.status === "failed"
        ? "x-circle"
        : turn.status === "interrupted"
          ? "stop"
          : "minus",
  );

  const reasons = new Map<string, string>([
    ["user", "by you"],
    ["interrupted", "by you"],
    ["drain", "worker draining"],
    ["worker_restart", "worker restarted"],
  ]);

  const reason = $derived(turn.interruptReason || result?.reason || "");

  // A known reason in words; a machine token (`process_exit`) humanized; prose as it is.
  const said = (value: string) =>
    reasons.get(value) ?? (isEnumToken(value) ? humanizeEnum(value).toLowerCase() : value);

  const detail = $derived.by(() => {
    if (turn.status === "failed") {
      const where =
        turn.errorSource === "harness" ? "Harness error" : turn.errorSource === "platform" ? "Platform error" : "";

      return [where, turn.error].filter(Boolean).join(": ");
    }

    if (turn.status === "interrupted" && turn.interruptSource === "system")
      return `by the system: ${said(reason) || "unknown reason"}`;

    // You know why you stopped it; what the harness logged then (e.g. Claude's "[ede_diagnostic] …") is in the hint.
    if (turn.status === "interrupted" && turn.interruptSource === "user") return "by you";

    return said(reason);
  });

  const canContinue = $derived(
    !directory.readOnly &&
      turn.status === "interrupted" &&
      turn.interruptSource === "system" &&
      !turn.inherited &&
      Boolean(directory.currentId),
  );

  let continuing = $state<"idle" | "sending" | "sent" | "error">("idle");

  // One key per footer: a retry after a network error does not queue the continuation twice.
  const continueRequest = crypto.randomUUID();

  async function continueTurn() {
    if (continuing === "sending" || continuing === "sent") return;
    continuing = "sending";

    try {
      await sendMessage(
        directory.currentId,
        turn.status === "failed"
          ? `Continue the previous request after the failed turn. Check what was already done before repeating anything with side effects. Previous request: ${turn.inputText}`
          : `Continue where you left off. Your previous turn was interrupted by the system (${reason || "unknown reason"}), not by me. Check what was already done before repeating anything with side effects.`,
        continueRequest,
      );
      continuing = "sent";
    } catch {
      continuing = "error";
    }
  }

  turnReveal.listen();
</script>

<div class="grid gap-1" data-shown={turnReveal.shows(turn.id) || undefined}>
  {#if turn.status === "failed"}
    <FailureNotice
      message={turn.error}
      code={turn.errorCode}
      classification={turn.errorClass}
      authHint={thread?.provider === Provider.CLAUDE
        ? "Open provider settings for this worker. Use its sign-in command, then retry."
        : thread?.provider === Provider.GROK
          ? "Run grok login on the worker using this instance's CLI home, then retry."
          : "Sign in from provider settings, or run codex login on the worker using this instance's CLI home."}
      source={turn.errorSource}
      {proxy}
      {providerHref}
      retrying={continuing === "sending"}
      retryDisabled={continuing === "sent"}
      onretry={!directory.readOnly && !turn.inherited && thread?.status === "idle" ? continueTurn : undefined}
      onchangemodel={!directory.readOnly && !turn.inherited && thread ? () => (modelOpen = true) : undefined}
    />
    {#if continuing === "sent"}<p role="status" class="text-sm text-zinc-500">Retry queued</p>{/if}
    {#if continuing === "error"}<p role="alert" class="text-sm text-rose-700 dark:text-rose-400">
        Could not queue the retry. Try again.
      </p>{/if}
  {:else if turn.status !== "completed"}
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm/5 sm:text-xs/5">
      <span class={["flex items-center gap-1 font-medium", textTones[look.tone]]}
        ><Icon name={icon} tone="inherit" class="size-3.5" />{look.label}</span
      >
      {#if detail}<span
          class={turn.status === "failed" ? "text-rose-700 dark:text-rose-400" : "text-zinc-500 dark:text-zinc-400"}
          title={turn.errorCode
            ? `Error code: ${turn.errorCode}`
            : turn.interruptSource === "user" && reason && reason !== "interrupted" && reason !== "user"
              ? reason
              : undefined}>{detail}</span
        >{/if}
      {#if canContinue}
        <button
          type="button"
          class="font-medium text-sky-700 hover:underline disabled:opacity-60 disabled:hover:no-underline dark:text-sky-400"
          disabled={continuing === "sending" || continuing === "sent"}
          title="Send a message that resumes the harness session with full context"
          onclick={continueTurn}
        >
          {continuing === "sent"
            ? "Continuation queued"
            : continuing === "sending"
              ? "Continuing…"
              : continuing === "error"
                ? "Continue (retry)"
                : "Continue"}
        </button>
      {/if}
    </div>
  {/if}
  <TurnDetails {turn} {result} {answer} />
</div>
{#if modelOpen && thread}<ThreadModelDialog bind:open={modelOpen} {thread} {worker} />{/if}

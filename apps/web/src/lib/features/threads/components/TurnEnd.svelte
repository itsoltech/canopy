<script lang="ts">
  import { humanizeEnum, isEnumToken } from "#lib/shared/humanize.ts";
  import type { ui } from "@canopy/contracts";
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
        `Continue where you left off. Your previous turn was interrupted by the system (${reason || "unknown reason"}), not by me. Check what was already done before repeating anything with side effects.`,
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
  {#if turn.status !== "completed"}
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm/5 sm:text-xs/5">
      <span class={["flex items-center gap-1 font-medium", textTones[look.tone]]}
        ><Icon name={icon} class="size-3.5" />{look.label}</span
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

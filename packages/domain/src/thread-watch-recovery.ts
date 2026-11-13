import { num, parseObject, str } from "./json.ts";
import { ThreadSyncGap, ThreadSyncLimit } from "./thread-sync.ts";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";

export function threadSyncStatus(batch: ui.ThreadSyncBatch) {
  return create(ui.ThreadSyncStatusSchema, {
    appliedSeq: batch.appliedSeq,
    headSeq: batch.headSeq,
    remaining: batch.remaining,
    caughtUp: batch.caughtUp,
  });
}

export const THREAD_WATCH_REASONS = [
  "size_limit",
  "invalid_range",
  "invalid_cursor",
  "decode_error",
  "access_unavailable",
  "computer_unreachable",
  "stream_unavailable",
  "timeout",
  "watch_failed",
  "invalid_record",
] as const;

export type ThreadWatchFailure = { code: number; computer?: boolean; reason?: string | undefined; frameBytes?: number };

/** Only fixed categories and numeric codes cross the diagnostics boundary. */
export function threadWatchFailure(code: number, reason = "", computer = false, frameBytes = 0): ThreadWatchFailure {
  return {
    code: Number.isInteger(code) && code >= 1 && code <= 16 ? code : 14,
    computer,
    reason: computer ? "computer_unreachable" : THREAD_WATCH_REASONS.find((value) => value === reason),
    frameBytes: Number.isSafeInteger(frameBytes) && frameBytes >= 0 && frameBytes <= 0xffffffff ? frameBytes : 0,
  };
}

export function threadUpdateFailure(cause: unknown): ThreadWatchFailure {
  if (cause instanceof ThreadSyncGap) return { code: 15, reason: "invalid_range" };

  if (cause instanceof ThreadSyncLimit) return { code: 8, reason: "size_limit", frameBytes: cause.frameBytes };

  return { code: 15, reason: "decode_error" };
}

export function readThreadWatchFailure(text: string): ThreadWatchFailure {
  const value = parseObject(text);

  return threadWatchFailure(
    num(value["code"]),
    str(value["reason"]),
    value["computer"] === true,
    num(value["frameBytes"]),
  );
}

export type ThreadWatchAction = "resume" | "reset" | "smaller" | "stop";

type RecoveryDecision = { action: ThreadWatchAction; reason: string };

/** Deterministic failures get two bounded repairs; retries preserve visible content. */
export class ThreadWatchRecovery {
  #repairs = 0;
  #failures = 0;
  #seq = 0n;
  #liveSince: number | undefined;
  failed(failure: ThreadWatchFailure): RecoveryDecision {
    this.#liveSince = undefined;

    if (failure.computer) return { action: "resume", reason: "computer_unreachable" };

    this.#failures++;

    if ([5, 7, 16].includes(failure.code)) return { action: "stop", reason: "access_unavailable" };

    // A lost batch leaves the last atomic checkpoint intact. Replay its bounded
    // suffix instead of discarding the base and all previously loaded pages.
    if (failure.reason === "invalid_range")
      return { action: this.#failures >= 3 ? "stop" : "resume", reason: "invalid_range" };

    if ([2, 3, 8, 11, 13, 15].includes(failure.code)) {
      const action = (["reset", "smaller", "stop"] as const)[Math.min(this.#repairs++, 2)]!;

      return {
        action,
        reason:
          new Map([
            [8, "size_limit"],
            [11, "invalid_cursor"],
          ]).get(failure.code) ??
          failure.reason ??
          "decode_error",
      };
    }

    return {
      action: this.#failures >= 3 ? "stop" : "resume",
      reason:
        failure.reason ??
        new Map([
          [4, "timeout"],
          [14, "stream_unavailable"],
        ]).get(failure.code) ??
        "watch_failed",
    };
  }
  advanced(seq: bigint, now = Date.now()) {
    this.#liveSince ??= now;

    if (seq >= this.#seq && now - this.#liveSince >= 10_000) {
      this.#failures = 0;
      this.#repairs = 0;
    }

    this.#seq = seq;
  }
  reset() {
    this.#repairs = 0;
    this.#failures = 0;
    this.#liveSince = undefined;
  }
}

export function threadWatchMessage(reason: string, computer = "The other computer") {
  switch (reason) {
    case "computer_unreachable":
      return `${computer} is unreachable. Showing saved messages.`;
    case "size_limit":
      return "This thread’s live update is too large. Retry or load from scratch.";
    case "invalid_cursor":
      return "This thread’s sync position is unavailable. Retry or load from scratch.";
    case "invalid_range":
      return "Some thread updates are missing. Retry to catch up.";
    case "stream_unavailable":
      return "The thread connection dropped. Retry to reconnect.";
    case "timeout":
      return "Thread updates timed out. Check the connection, then retry.";
    case "decode_error":
      return "This thread’s live update could not be read. Retry or load from scratch.";
    case "access_unavailable":
      return "This thread is no longer available. Return to Threads or retry.";
    default:
      return "Live updates for this thread are unavailable. Retry or load from scratch.";
  }
}

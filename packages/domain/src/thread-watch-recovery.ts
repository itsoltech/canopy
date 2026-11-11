import { num, parseObject } from "./json.ts";
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

export type ThreadWatchFailure = { code: number; computer?: boolean };

export function readThreadWatchFailure(text: string): ThreadWatchFailure {
  const value = parseObject(text);

  return { code: num(value["code"]) || 14, computer: value["computer"] === true };
}

export type ThreadWatchAction = "resume" | "reset" | "smaller" | "stop";

type RecoveryDecision = { action: ThreadWatchAction; reason: string };

/** Deterministic failures get two bounded repairs; retries preserve visible content. */
export class ThreadWatchRecovery {
  #repairs = 0;
  #failures = 0;
  #seq = 0n;
  failed(failure: ThreadWatchFailure): RecoveryDecision {
    this.#failures++;

    if (failure.computer) return { action: "resume", reason: "computer_unreachable" };

    if ([5, 7, 16].includes(failure.code)) return { action: "stop", reason: "access_unavailable" };

    if ([2, 3, 8, 11, 13, 15].includes(failure.code)) {
      const action = (["reset", "smaller", "stop"] as const)[Math.min(this.#repairs++, 2)]!;

      return {
        action,
        reason:
          new Map([
            [8, "size_limit"],
            [11, "invalid_cursor"],
          ]).get(failure.code) ?? "decode_error",
      };
    }

    return { action: this.#failures >= 3 ? "stop" : "resume", reason: "watch_failed" };
  }
  advanced(seq: bigint) {
    if (seq > this.#seq) {
      this.#seq = seq;
      this.#failures = 0;
    }
  }
  reset() {
    this.#repairs = 0;
    this.#failures = 0;
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
    case "decode_error":
      return "This thread’s live update could not be read. Retry or load from scratch.";
    case "access_unavailable":
      return "This thread is no longer available. Return to Threads or retry.";
    default:
      return "Live updates for this thread are unavailable. Retry or load from scratch.";
  }
}

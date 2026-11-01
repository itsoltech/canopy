import { clone } from "@bufbuild/protobuf";
import { ItemSchema, ItemStatus, TurnEndSource, TurnOutcome, type ThreadEvent } from "@open-agents/contracts";
import { Effect } from "effect";
import { Journal, type OpenTurn, type ThreadEventInit } from "../journal/index.ts";
import { readClaudeTurn } from "./claude/transcript.ts";
import { readCodexTurn } from "./codex/transcript.ts";
import type { HarnessRecord, TurnEnd } from "./harness-record.ts";

/**
 * Harness-truth reconciliation (docs/durability.md, "Rekoncyliacja z transkryptu harnessu"). A turn whose end the
 * worker did not see (the worker restarted, the harness process died) is settled from what its harness wrote down:
 *
 * 1. Items the harness recorded and the journal does not have as finished are journaled as finished, in the
 *    harness's order, under the ids the live events used (no duplicates: finished items are skipped, the gateway's
 *    reducer replaces the open ones). What the harness left unfinished ends as interrupted.
 * 2. Items the journal has open and the harness never recorded end as interrupted.
 * 3. The turn ends the way the harness ended it (completed with its result, failed with its error, interrupted); a
 *    turn the harness never ended ends with the caller's cause (e.g. interrupted by the system: "worker restarted
 *    mid-turn", or failed in the harness: its process exited). An interruption is the user's only when the platform
 *    asked for it (journal): Codex also aborts a turn ("interrupted") when the worker dies and its input closes.
 *
 * Where no record exists (no transcript, unreadable), steps 2 and 3 still close everything.
 */

/** Why the turn ended when its harness did not record an end. */
export type EndCause = Omit<TurnEnd, "providerTurnRef" | "usage">;

/** The worker process that ran the turn is gone (this one started after it). */
export const WORKER_RESTARTED: EndCause = { outcome: TurnOutcome.INTERRUPTED, source: TurnEndSource.SYSTEM, reason: "worker restarted mid-turn" };

/** The harness's record of an open turn, or undefined (no transcript known, unreadable, or nothing of the turn in it). */
export async function readHarnessRecord(open: OpenTurn): Promise<HarnessRecord | undefined> {
  const harness = open.harness;
  if (!harness) return undefined;
  try {
    return harness.harness === "codex"
      ? await readCodexTurn(harness.transcript, harness.offset, harness.providerTurn, open.turnId)
      : await readClaudeTurn(harness.transcript, harness.sessionId, harness.offset);
  } catch {
    return undefined;
  }
}

/** The events that settle an open turn (items first, turn_finished last). */
export function reconcileEvents(open: OpenTurn, record: HarnessRecord | undefined, cause: EndCause): ThreadEventInit[] {
  const { turnId } = open;
  const rawJson = JSON.stringify({ reconciled: open.harness ? `${open.harness.harness} transcript` : "journal", found: record !== undefined });
  const finished = (item: ThreadEventInit["body"] & { case: "itemCompleted" }): ThreadEventInit => ({ turnId, rawJson, body: item });
  const journaled = new Map(open.items.map((i) => [i.item.itemId, i]));
  const events: ThreadEventInit[] = [];
  const seen = new Set<string>();
  for (const item of record?.items ?? []) {
    const id = item.itemId ?? "";
    seen.add(id);
    if (journaled.get(id)?.done) continue;
    const status = item.status === ItemStatus.IN_PROGRESS ? ItemStatus.INTERRUPTED : (item.status ?? ItemStatus.COMPLETED);
    events.push(finished({ case: "itemCompleted", value: { item: { ...item, status } } }));
  }
  for (const { item, done } of open.items) {
    if (done || seen.has(item.itemId)) continue;
    const ended = clone(ItemSchema, item);
    ended.status = ItemStatus.INTERRUPTED;
    events.push(finished({ case: "itemCompleted", value: { item: ended } }));
  }
  const recorded = record?.end;
  const end: TurnEnd =
    recorded?.outcome === TurnOutcome.INTERRUPTED && recorded.source !== TurnEndSource.SYSTEM && !open.interruptRequested
      ? { ...recorded, source: TurnEndSource.SYSTEM, reason: `${cause.reason} (the harness stopped the turn: ${recorded.reason || "interrupted"})` }
      : (recorded ?? cause);
  events.push({
    turnId,
    rawJson,
    body: {
      case: "turnFinished",
      value: {
        outcome: end.outcome,
        source: end.source,
        reason: end.reason,
        ...(end.errorCode && { errorCode: end.errorCode }),
        ...(end.providerTurnRef && { providerTurnRef: end.providerTurnRef }),
        ...(end.usage && { usage: end.usage }),
      },
    },
  });
  return events;
}

/** Reads the harness record of an open turn and journals what settles it. Returns the journaled events, to send. */
export const reconcileTurn = (open: OpenTurn, cause: EndCause) =>
  Effect.gen(function* () {
    const journal = yield* Journal;
    const record = yield* Effect.promise(() => readHarnessRecord(open));
    const out: ThreadEvent[] = [];
    for (const init of reconcileEvents(open, record, cause)) out.push(yield* journal.append(open.threadId, init));
    return { events: out, record };
  });

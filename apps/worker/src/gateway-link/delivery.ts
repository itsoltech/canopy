import type { MessageInitShape } from "@bufbuild/protobuf";
import type { EventAck, HelloSchema } from "@open-agents/contracts";
import { Effect } from "effect";
import { Journal } from "../journal/index.ts";
import type { GatewayLink } from "./link.ts";

/**
 * Journal <-> gateway delivery (docs/protocol.md, "Dostarczanie transkryptu").
 * At-least-once: events stay in the journal until acked after the gateway's commit;
 * the gateway deduplicates by event_id, so resending is always safe.
 */

/** Hello fields that describe the journal: its id and the threads with unacked events. */
export const journalHello = Effect.fn("delivery.journalHello")(function* () {
  const journal = yield* Journal;
  const cursors = yield* journal.cursors();
  return {
    journalId: journal.journalId,
    threads: cursors.map((c) => ({ threadId: c.threadId, lastSeq: c.lastSeq })),
  } satisfies Pick<MessageInitShape<typeof HelloSchema>, "journalId" | "threads">;
});

/** After Welcome: drop what the gateway already has, resend the rest in order. Returns how many were sent. */
export const resendPending = Effect.fn("delivery.resendPending")(function* (link: GatewayLink) {
  const journal = yield* Journal;
  const persisted = new Map(link.welcome.persisted.map((c) => [c.threadId, c.lastSeq] as const));
  const events = yield* journal.pending(persisted);
  for (const event of events) link.send({ case: "threadEvent", value: event });
  return events.length;
});

export const applyAck = Effect.fn("delivery.applyAck")(function* (ack: EventAck) {
  const journal = yield* Journal;
  return yield* journal.ack(ack.threadId, ack.ackSeq);
});

/**
 * Durable transcript delivery: worker journal (SQLite) <-> gateway over the real gRPC link.
 * The gateway side is a fake store that persists by event_id and remembers cursors per journal_id.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ItemDeltaField, type ThreadEvent } from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { applyAck, journalHello, resendPending, type GatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { Effect, ManagedRuntime } from "effect";
import { connectWorker, startGateway, take } from "./helpers.ts";

const dir = tempDir("oa-delivery-");

/** Gateway-side persistence: cursors per journal, event ids already stored. */
class FakeStore {
  readonly cursors = new Map<string, Map<string, bigint>>();
  readonly stored = new Map<string, ThreadEvent>();
  duplicates = 0;

  persist(journalId: string, event: ThreadEvent): void {
    if (this.stored.has(event.eventId)) this.duplicates++;
    else this.stored.set(event.eventId, event);
  }
  commit(journalId: string, threadId: string, seq: bigint): void {
    const cursors = this.cursors.get(journalId) ?? new Map<string, bigint>();
    cursors.set(threadId, seq);
    this.cursors.set(journalId, cursors);
  }
}

const delta = (chunk: string) => ({ turnId: "turn-1", body: { case: "itemDelta" as const, value: { itemId: "m", field: ItemDeltaField.TEXT, chunk } } });

async function connect(runtime: ManagedRuntime.ManagedRuntime<Journal, unknown>, url: string): Promise<GatewayLink> {
  const hello = await runtime.runPromise(journalHello());
  const link = await connectWorker(url, { hello: { workerId: "worker-1", ...hello } });
  await runtime.runPromise(resendPending(link));
  return link;
}

describe("durable delivery from the worker journal", () => {
  test("offline events are delivered, partial acks survive reconnect, resends are deduplicated", async () => {
    const store = new FakeStore();
    const gateway = await startGateway({
      link: {
        welcome: async (_workerId, hello) => ({
          heartbeatIntervalSeconds: 15,
          persisted: [...(store.cursors.get(hello.journalId) ?? new Map())].map(([threadId, lastSeq]) => ({ threadId, lastSeq })),
        }),
      },
    });
    const runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));
    const journalId = await runtime.runPromise(Effect.map(Journal, (j) => j.journalId));

    // Worker produced events while the gateway was unreachable.
    await runtime.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal;
        for (const chunk of ["a", "b", "c"]) yield* journal.append("t1", delta(chunk));
        for (const chunk of ["x", "y"]) yield* journal.append("t2", delta(chunk));
      }),
    );

    // First connection: everything is sent; the gateway commits t1 only up to 2 and t2 fully.
    let link = await connect(runtime, gateway.server.url);
    let connection = await gateway.nextConnection();
    const first = await take(connection.messages, 5);
    for (const m of first) if (m.payload.case === "threadEvent") store.persist(journalId, m.payload.value);
    store.commit(journalId, "t1", 2n);
    store.commit(journalId, "t2", 2n);
    connection.send({ case: "eventAck", value: { threadId: "t1", ackSeq: 2n } });
    connection.send({ case: "eventAck", value: { threadId: "t2", ackSeq: 2n } });
    for (const m of await take(link.messages, 2)) {
      if (m.payload.case === "eventAck") await runtime.runPromise(applyAck(m.payload.value));
    }
    expect(first.map((m) => (m.payload.case === "threadEvent" ? `${m.payload.value.threadId}:${m.payload.value.journalSeq}` : "?"))).toEqual([
      "t1:1",
      "t1:2",
      "t1:3",
      "t2:1",
      "t2:2",
    ]);
    link.close();
    await connection.closed;

    // Reconnect: Hello says t1 has unacked events up to 3; Welcome says 2 is persisted -> only t1:3 is resent.
    const hello = await runtime.runPromise(journalHello());
    expect(hello.threads).toEqual([{ threadId: "t1", lastSeq: 3n }]);
    link = await connect(runtime, gateway.server.url);
    connection = await gateway.nextConnection();
    const [resent] = await take(connection.messages, 1);
    if (resent?.payload.case !== "threadEvent") throw new Error("expected a resent event");
    expect(resent.payload.value.journalSeq).toBe(3n);
    store.persist(journalId, resent.payload.value);
    expect(store.duplicates).toBe(1); // same event_id as in the first delivery: the gateway ignores it
    expect(store.stored.size).toBe(5);

    link.close();
    await connection.closed;
    await runtime.dispose();
    await gateway.link.shutdown();
    await gateway.server.close();
  });

  test("a reinstalled worker starts a new journal: old cursors do not apply", async () => {
    const id = (path: string) => {
      const runtime = ManagedRuntime.make(Journal.layer(path));
      return runtime.runPromise(Effect.map(Journal, (j) => j.journalId)).finally(() => runtime.dispose());
    };
    expect(await id(join(dir, "a.db"))).not.toBe(await id(join(dir, "b.db")));
  });
});

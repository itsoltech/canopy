import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ItemDeltaField, ItemStatus, TurnOutcome } from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { Effect } from "effect";
import { Journal, type ThreadEventInit } from "./journal.ts";

const dir = tempDir("canopy-journal-");
let n = 0;
const freshPath = () => join(dir, `journal-${++n}.db`);

/** Runs a program against the journal file, opening and closing it around the run (like a process lifetime). */
const withJournal = <A, E>(path: string, program: (journal: Journal["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;

      return yield* program(journal);
    }).pipe(Effect.provide(Journal.layer(path))),
  );

const delta = (chunk: string): ThreadEventInit => ({
  turnId: "turn-1",
  body: { case: "itemDelta", value: { itemId: "m1", field: ItemDeltaField.TEXT, chunk } },
});

describe("Journal", () => {
  test("append assigns increasing journal_seq per thread and unique event ids", async () => {
    const events = await withJournal(freshPath(), (j) =>
      Effect.all([j.append("t1", delta("a")), j.append("t1", delta("b")), j.append("t2", delta("c"))]),
    );

    expect(events.map((e) => [e.threadId, e.journalSeq])).toEqual([
      ["t1", 1n],
      ["t1", 2n],
      ["t2", 1n],
    ]);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(3);
    expect(events[0]?.occurredAt).toBeDefined();
  });

  test("survives reopening: same journal id, unacked events kept, seq continues after full ack", async () => {
    const path = freshPath();

    const first = await withJournal(path, (j) =>
      Effect.gen(function* () {
        yield* j.append("t1", delta("a"));
        yield* j.append("t1", delta("b"));
        yield* j.ack("t1", 2n); // everything acked
        yield* j.append("t2", delta("x"));

        return j.journalId;
      }),
    );

    const [journalId, cursors, next] = await withJournal(path, (j) =>
      Effect.all([Effect.succeed(j.journalId), j.cursors(), j.append("t1", delta("c"))]),
    );

    expect(journalId).toBe(first);
    expect(cursors).toEqual([{ threadId: "t2", lastSeq: 1n }]);
    expect(next.journalSeq).toBe(3n); // never reuses 1..2 although they were deleted
  });

  test("a new journal file gets a new journal id", async () => {
    const a = await withJournal(freshPath(), (j) => Effect.succeed(j.journalId));
    const b = await withJournal(freshPath(), (j) => Effect.succeed(j.journalId));
    expect(a).not.toBe(b);
  });

  test("pending: drops what the gateway already persisted, returns the rest in order", async () => {
    const pending = await withJournal(freshPath(), (j) =>
      Effect.gen(function* () {
        for (const chunk of ["a", "b", "c"]) yield* j.append("t1", delta(chunk));

        for (const chunk of ["x", "y"]) yield* j.append("t2", delta(chunk));
        // Welcome: t1 persisted up to 2, nothing known for t2 (e.g. a new journal id).
        const resend = yield* j.pending(new Map([["t1", 2n]]));

        return { resend, cursors: yield* j.cursors() };
      }),
    );

    expect(pending.resend.map((e) => `${e.threadId}:${e.journalSeq}`)).toEqual(["t1:3", "t2:1", "t2:2"]);
    expect(pending.cursors).toEqual([
      { threadId: "t1", lastSeq: 3n },
      { threadId: "t2", lastSeq: 2n },
    ]);
  });

  test("ack removes up to the cursor only", async () => {
    const result = await withJournal(freshPath(), (j) =>
      Effect.gen(function* () {
        for (const chunk of ["a", "b", "c"]) yield* j.append("t1", delta(chunk));
        const removed = yield* j.ack("t1", 2n);

        return { removed, left: yield* j.pending(new Map()) };
      }),
    );

    expect(result.removed).toBe(2);
    expect(result.left.map((e) => e.journalSeq)).toEqual([3n]);
  });

  test("remembers command results for redelivery and purges old ones", async () => {
    const path = freshPath();
    await withJournal(path, (j) => j.rememberCommand({ commandId: "c1", ok: false, errorCode: "THREAD_BUSY" }));

    const [remembered, unknown] = await withJournal(path, (j) =>
      Effect.all([j.commandResult("c1"), j.commandResult("c2")]),
    );

    expect(remembered).toMatchObject({ commandId: "c1", ok: false, errorCode: "THREAD_BUSY" });
    expect(unknown).toBeUndefined();

    const purged = await withJournal(path, (j) =>
      Effect.gen(function* () {
        yield* Effect.sleep("5 millis");

        return yield* j.purgeCommands(1);
      }),
    );

    expect(purged).toBe(1);
  });

  test("tracks background tasks until their end is journaled, across reopening", async () => {
    const path = freshPath();

    const task = (status: ItemStatus) => ({
      body: {
        case: "itemStarted" as const,
        value: {
          item: {
            itemId: "bg:1",
            status,
            content: { case: "backgroundTask" as const, value: { taskId: "1", command: "npm run dev" } },
          },
        },
      },
    });

    await withJournal(path, (j) =>
      Effect.gen(function* () {
        yield* j.append("t1", task(ItemStatus.IN_PROGRESS));
        yield* j.append("t2", task(ItemStatus.IN_PROGRESS));
        yield* j.append("t2", {
          body: {
            case: "itemCompleted",
            value: {
              item: {
                itemId: "bg:1",
                status: ItemStatus.INTERRUPTED,
                content: { case: "backgroundTask", value: { taskId: "1" } },
              },
            },
          },
        });
      }),
    );
    const open = await withJournal(path, (j) => j.openBackgroundTasks());
    expect(
      open.map((o) => [
        o.threadId,
        o.item.itemId,
        o.item.content.case === "backgroundTask" && o.item.content.value.command,
      ]),
    ).toEqual([["t1", "bg:1", "npm run dev"]]);
  });

  test("tracks turns until their end is journaled, across reopening", async () => {
    const path = freshPath();
    await withJournal(path, (j) =>
      Effect.gen(function* () {
        yield* j.append("t1", { turnId: "u1", body: { case: "turnStarted", value: {} } });
        yield* j.append("t1", {
          turnId: "u1",
          body: { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED } },
        });
        yield* j.append("t1", { turnId: "u2", body: { case: "turnStarted", value: {} } });
        yield* j.append("t2", { turnId: "u3", body: { case: "turnStarted", value: {} } });
        yield* j.append("t2", { turnId: "", body: { case: "turnStarted", value: {} } });
      }),
    );
    // Acked events are gone; the turn is still open (its end never came).
    await withJournal(path, (j) => j.ack("t1", 10n));
    expect(await withJournal(path, (j) => j.openTurns())).toEqual([
      { threadId: "t1", turnId: "u2", items: [], interruptRequested: false },
      { threadId: "t2", turnId: "u3", items: [], interruptRequested: false },
    ]);
  });

  test("keeps the harness record and the items of open turns until their end", async () => {
    const path = freshPath();

    const harness = {
      harness: "codex" as const,
      transcript: "/rollout.jsonl",
      sessionId: "c1",
      offset: 120,
      providerTurn: "",
    };

    await withJournal(path, (j) =>
      Effect.gen(function* () {
        yield* j.noteHarness("t1", "u1", harness);
        yield* j.append("t1", { turnId: "u1", body: { case: "turnStarted", value: {} } });
        yield* j.noteHarness("t1", "u1", { ...harness, providerTurn: "codex-turn" });
        yield* j.noteInterrupt("t1", "u1");

        const item = (id: string, status: ItemStatus) => ({
          itemId: id,
          status,
          content: { case: "agentMessage" as const, value: { text: id } },
        });

        yield* j.append("t1", {
          turnId: "u1",
          body: { case: "itemStarted", value: { item: item("a", ItemStatus.IN_PROGRESS) } },
        });
        yield* j.append("t1", {
          turnId: "u1",
          body: { case: "itemCompleted", value: { item: item("a", ItemStatus.COMPLETED) } },
        });
        yield* j.append("t1", {
          turnId: "u1",
          body: { case: "itemStarted", value: { item: item("b", ItemStatus.IN_PROGRESS) } },
        });
        // A late started event does not reopen a finished item; items of turns that are not open are not tracked.
        yield* j.append("t1", {
          turnId: "u1",
          body: { case: "itemStarted", value: { item: item("a", ItemStatus.IN_PROGRESS) } },
        });
        yield* j.append("t1", {
          turnId: "other",
          body: { case: "itemStarted", value: { item: item("c", ItemStatus.IN_PROGRESS) } },
        });
      }),
    );
    const [open] = await withJournal(path, (j) => j.openTurns());
    expect(open?.harness).toEqual({ ...harness, providerTurn: "codex-turn" });
    expect(open?.interruptRequested).toBe(true);
    expect(open?.items.map((i) => [i.item.itemId, i.done])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    await withJournal(path, (j) =>
      j.append("t1", { turnId: "u1", body: { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED } } }),
    );
    expect(await withJournal(path, (j) => j.openTurns())).toEqual([]);
  });
});

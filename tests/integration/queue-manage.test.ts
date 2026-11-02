/**
 * Managing the queue on PostgreSQL (docs/ui-api.md, "Kolejka"): queued messages behind a running turn are
 * reordered, edited, deleted (and restored) and steered into the running turn; the new order is the order they
 * run in. The scheduler starting the head races with every one of them: a started turn cannot be changed and
 * the scheduler starts only the head it read, with the input it read.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MentionKind, PermissionMode, Provider, ui } from "@open-agents/contracts";
import { quotesNote } from "@open-agents/domain";
import { dockerAvailable } from "@open-agents/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { QueueStore } from "@open-agents/gateway/store";
import { eventually, failure, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";

let gw: TestGateway;
let projectId = "";
let workspaceId = "";

const query = <A extends object>(text: string, ...params: unknown[]) =>
  gw.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.unsafe<A>(text, params as never[]);
    }),
  );
const turns = (threadId: string) =>
  query<{ id: string; ordinal: number; status: string; text: string; withdrawn: string | null; revision: number; effort: string; permission_mode: string }>(
    "SELECT id, ordinal, status, input->>'text' AS text, withdrawn, revision, effort, permission_mode FROM turns WHERE thread_id = $1::uuid ORDER BY ordinal",
    threadId,
  );
const queuedTexts = async (threadId: string) => (await turns(threadId)).filter((t) => t.status === "queued").map((t) => t.text);
const steers = (threadId: string) =>
  query<{ id: string; status: string; queued_turn_id: string | null; from_turn_id: string | null }>(
    "SELECT id, status, queued_turn_id, from_turn_id FROM turn_steers WHERE thread_id = $1::uuid ORDER BY created_at",
    threadId,
  );

/** A thread with a held (running) first turn and the given messages queued behind it. */
async function busyThread(title: string, messages: string[]) {
  gw.worker.holdTurns = true;
  const thread = (
    await gw.api.createThread({ projectId, workspaceId, title, provider: Provider.CODEX, permissionMode: PermissionMode.ASK, clientRequestId: `create-${title}`, initialMessage: "long task" })
  ).thread!;
  const [running] = await eventually(() => turns(thread.id), (t) => t[0]?.status === "running");
  const queued: ui.Turn[] = [];
  for (const [i, text] of messages.entries()) {
    queued.push((await gw.api.sendMessage({ threadId: thread.id, text, clientRequestId: `${title}-${i}` })).turn!);
  }
  return { thread, runningId: running!.id, queued };
}

/** Lets the held turns run to the end, one after another, and returns the texts in the order the worker got them. */
async function drain(threadId: string, runningId: string, count: number): Promise<string[]> {
  gw.worker.holdTurns = false;
  gw.worker.finish(threadId, runningId);
  await eventually(() => turns(threadId), (t) => t.filter((x) => x.status === "completed").length === count + 1, 10_000);
  return (gw.worker.inputs.get(threadId) ?? []).slice(1);
}

describe.skipIf(!dockerAvailable)("managing the queue (gateway + scripted worker)", () => {
  beforeAll(async () => {
    gw = await startTestGateway();
    projectId = (await gw.api.createProject({ name: "Queue" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/app", label: "" })).workspace!.id;
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  test("reorder: the new order is the execution order; every client hears the moved turns", async () => {
    const { thread, runningId, queued } = await busyThread("reorder", ["A", "B", "C"]);
    const [a, b, c] = queued.map((t) => t.id) as [string, string, string];
    const live: ui.Turn[] = [];
    const watching = watchUntil(gw.api, thread.id, (u) => u.filter((x) => x.change.case === "turn").length >= 3, (u) => {
      if (u.change.case === "turn") live.push(u.change.value);
    });
    await Bun.sleep(100); // the snapshot first
    const moved = await gw.api.reorderQueuedTurns({ threadId: thread.id, turnIds: [c, a, b] });
    expect(moved.turns.map((t) => t.inputText)).toEqual(["C", "A", "B"]);
    expect(moved.turns.map((t) => t.ordinal)).toEqual([...queued.map((t) => t.ordinal)].sort((x, y) => x - y));
    await watching;
    expect(new Map(live.map((t) => [t.id, t.ordinal]))).toEqual(new Map(moved.turns.map((t) => [t.id, t.ordinal])));
    expect(await queuedTexts(thread.id)).toEqual(["C", "A", "B"]);

    // A subset moves among its own places; the others stay.
    await gw.api.reorderQueuedTurns({ threadId: thread.id, turnIds: [b, c] });
    expect(await queuedTexts(thread.id)).toEqual(["B", "A", "C"]);

    expect(await failure(gw.api.reorderQueuedTurns({ threadId: thread.id, turnIds: [a, a] }))).toContain("listed twice");
    expect(await failure(gw.api.reorderQueuedTurns({ threadId: thread.id, turnIds: [a, runningId] }))).toContain("already started");
    expect(await failure(gw.api.reorderQueuedTurns({ threadId: thread.id, turnIds: [a, crypto.randomUUID()] }))).toContain("not found");

    expect(await drain(thread.id, runningId, 3)).toEqual(["B", "A", "C"]);
  });

  test("edit: a new text with the overrides kept; a stale revision or a started turn is refused", async () => {
    const { thread, runningId } = await busyThread("edit", []);
    const sent = (await gw.api.sendMessage({ threadId: thread.id, text: "draft", clientRequestId: "edit-x", effort: "high", permissionMode: PermissionMode.READ_ONLY })).turn!;
    expect(sent.revision).toBe(0);
    const edited = await gw.api.editQueuedTurn({ turnId: sent.id, text: "final", expectedRevision: 0 });
    expect([edited.turn?.inputText, edited.turn?.messageText, edited.turn?.revision, edited.turn?.effort]).toEqual(["final", "final", 1, "high"]);
    expect(await failure(gw.api.editQueuedTurn({ turnId: sent.id, text: "other", expectedRevision: 0 }))).toContain("changed elsewhere");
    expect(await failure(gw.api.editQueuedTurn({ turnId: sent.id, text: "  ", expectedRevision: 1 }))).toContain("empty");
    expect(await failure(gw.api.editQueuedTurn({ turnId: runningId, text: "x", expectedRevision: 0 }))).toContain("already started");

    expect(await drain(thread.id, runningId, 1)).toEqual(["final"]);
    const [, ran] = await turns(thread.id);
    expect([ran?.effort, ran?.permission_mode]).toEqual(["high", "READ_ONLY"]);
    expect(await failure(gw.api.editQueuedTurn({ turnId: sent.id, text: "late", expectedRevision: 1 }))).toContain("no longer queued");
  });

  test("edit keeps the message's quotes and composes its mentions again; steer now carries them", async () => {
    const { thread, runningId } = await busyThread("edit-rich", []);
    const quote = { text: "FAIL src/a.test.ts", sourceItemId: "item-b", sourceKind: "command_output" };
    const skill = (start: number) => ({ kind: MentionKind.SKILL, name: "review", start, end: start + 7 });
    const sent = (await gw.api.sendMessage({ threadId: thread.id, text: "use $review", clientRequestId: "rich-1", quotes: [quote], mentions: [skill(4)] })).turn!;
    expect(sent.mentions.map((m) => [m.start, m.end])).toEqual([[4, 11]]);

    const edited = (await gw.api.editQueuedTurn({ turnId: sent.id, text: "please use $review now", expectedRevision: 0, mentions: [skill(11)] })).turn!;
    expect([edited.messageText, edited.mentions.map((m) => [m.name, m.start, m.end])]).toEqual(["please use $review now", [["review", 11, 18]]]);
    expect(edited.quotes.map((q) => q.sourceItemId)).toEqual(["item-b"]);
    expect(edited.platformNote).toContain(quotesNote([quote]));
    expect(edited.inputText.endsWith("please use $review now")).toBe(true);
    expect(await failure(gw.api.editQueuedTurn({ turnId: sent.id, text: "x", expectedRevision: 1, mentions: [skill(4)] }))).toContain("outside the text");
    // Quotes alone may stay: the text can go.
    expect((await gw.api.editQueuedTurn({ turnId: sent.id, text: "", expectedRevision: 1 })).turn?.inputText).toBe(quotesNote([quote]));
    await gw.api.editQueuedTurn({ turnId: sent.id, text: "please use $review now", expectedRevision: 2, mentions: [skill(11)] });

    gw.worker.steerMode = "accept";
    const steered = await gw.api.steerQueuedTurn({ turnId: sent.id });
    expect([steered.steer?.mentions.map((m) => m.name), steered.steer?.quotes.map((q) => q.sourceItemId)]).toEqual([["review"], ["item-b"]]);
    await eventually(() => steers(thread.id), (x) => x[0]?.status === "delivered");
    expect(gw.worker.steered.get(steered.steer!.id)).toContain(quotesNote([quote]));
    expect(await drain(thread.id, runningId, 0)).toEqual([]);
  });

  test("delete and undo: the turn leaves the queue (hidden, cancelled) and comes back at its place", async () => {
    const { thread, runningId, queued } = await busyThread("delete", ["A", "B", "C"]);
    const b = queued[1]!.id;
    const deleted = await gw.api.deleteQueuedTurn({ turnId: b });
    expect([deleted.turn?.status, deleted.turn?.withdrawn]).toEqual(["cancelled", "deleted"]);
    expect(await queuedTexts(thread.id)).toEqual(["A", "C"]);
    expect(await failure(gw.api.deleteQueuedTurn({ turnId: b }))).toContain("no longer in the queue");

    const restored = await gw.api.restoreQueuedTurn({ turnId: b });
    expect([restored.turn?.status, restored.turn?.withdrawn]).toEqual(["queued", ""]);
    expect(await queuedTexts(thread.id)).toEqual(["A", "B", "C"]);
    expect((await gw.api.restoreQueuedTurn({ turnId: b })).turn?.status).toBe("queued"); // idempotent

    await gw.api.deleteQueuedTurn({ turnId: b });
    expect(await drain(thread.id, runningId, 2)).toEqual(["A", "C"]);
    // A deleted turn stays out of the snapshot's timeline as withdrawn.
    const snapshot = (await watchUntil(gw.api, thread.id, (u) => u.length >= 1))[0]!;
    const view = snapshot.change.case === "snapshot" ? snapshot.change.value : undefined;
    expect(view?.turns.find((t) => t.id === b)?.withdrawn).toBe("deleted");
  });

  test("steer now: the queued message joins the running turn; when it cannot, it is back at its place", async () => {
    gw.worker.steerMode = "accept";
    const { thread, runningId, queued } = await busyThread("steer-now", ["A", "B", "C"]);
    const b = queued[1]!.id;
    const steered = await gw.api.steerQueuedTurn({ turnId: b });
    expect([steered.turn?.status, steered.turn?.withdrawn, steered.steer?.turnId, steered.steer?.fromTurnId, steered.steer?.text]).toEqual([
      "cancelled",
      "steered",
      runningId,
      b,
      "B",
    ]);
    await eventually(() => steers(thread.id), (s) => s[0]?.status === "delivered");
    expect(gw.worker.steered.get(steered.steer!.id)).toBe("B");
    expect(await queuedTexts(thread.id)).toEqual(["A", "C"]);

    // The turn ended before the steer could join it: the message is queued again, where it was.
    gw.worker.steerMode = "not_running";
    const c = queued[2]!.id;
    const late = await gw.api.steerQueuedTurn({ turnId: c });
    const [, fallback] = await eventually(() => steers(thread.id), (s) => s[1]?.status === "queued");
    expect([fallback?.queued_turn_id, fallback?.from_turn_id]).toEqual([c, c]);
    expect(late.steer?.fromTurnId).toBe(c);
    expect(await queuedTexts(thread.id)).toEqual(["A", "C"]);
    expect((await turns(thread.id)).find((t) => t.id === c)?.withdrawn).toBeNull();
    gw.worker.steerMode = "accept";

    expect(await drain(thread.id, runningId, 2)).toEqual(["A", "C"]);
    // Nothing runs: steering from the queue is refused and the message stays.
    gw.worker.holdTurns = true;
    const idle = (await gw.api.sendMessage({ threadId: thread.id, text: "D", clientRequestId: "steer-now-d" })).turn!;
    const started = await eventually(() => turns(thread.id), (t) => t.find((x) => x.id === idle.id)?.status === "running");
    expect(started.find((x) => x.id === idle.id)?.status).toBe("running");
    const e = (await gw.api.sendMessage({ threadId: thread.id, text: "E", clientRequestId: "steer-now-e" })).turn!;
    gw.worker.finish(thread.id, idle.id); // E starts next and stays running (held)
    await eventually(() => turns(thread.id), (t) => t.find((x) => x.id === e.id)?.status === "running");
    expect(await failure(gw.api.steerQueuedTurn({ turnId: e.id }))).toContain("already started");
    gw.worker.holdTurns = false;
    gw.worker.finish(thread.id, e.id);
  });

  test("a StartTurn on its way (not yet running) already counts as started", async () => {
    const { thread, runningId, queued } = await busyThread("dispatched", ["A", "B"]);
    const [a, b] = queued.map((t) => t.id) as [string, string];
    // The worker takes StartTurn of A and answers only later.
    let release: (() => void) | undefined;
    gw.worker.handlers.set("startTurn", (_value, reply) => {
      release = () => reply(true);
    });
    gw.worker.finish(thread.id, runningId);
    await eventually(async () => release, Boolean);
    expect((await turns(thread.id)).find((t) => t.id === a)?.status).toBe("queued");
    expect(await failure(gw.api.reorderQueuedTurns({ threadId: thread.id, turnIds: [b, a] }))).toContain("already started");
    expect(await failure(gw.api.editQueuedTurn({ turnId: a, text: "x", expectedRevision: 0 }))).toContain("already started");
    expect(await failure(gw.api.deleteQueuedTurn({ turnId: a }))).toContain("already started");
    expect((await gw.api.reorderQueuedTurns({ threadId: thread.id, turnIds: [b] })).turns).toHaveLength(1);
    gw.worker.handlers.delete("startTurn");
    release?.();
  });

  test("races with the head starting: the scheduler starts the head as it stands, with its current text", async () => {
    for (let round = 0; round < 10; round++) {
      const { thread, runningId, queued } = await busyThread(`race-${round}`, ["A", "B", "C"]);
      const [a, b, c] = queued.map((t) => t.id) as [string, string, string];
      gw.worker.holdTurns = false;
      // The running turn ends while the user moves C to the top and edits A.
      gw.worker.finish(thread.id, runningId);
      await Bun.sleep(round * 8); // from before the scheduler reads the queue to after it started the head
      const [reordered, edited] = await Promise.all([
        failure(gw.api.reorderQueuedTurns({ threadId: thread.id, turnIds: [c, a, b] })),
        failure(gw.api.editQueuedTurn({ turnId: a, text: "A2", expectedRevision: 0 })),
      ]);
      await eventually(() => turns(thread.id), (t) => t.filter((x) => x.status === "completed").length === 4, 10_000);
      const ran = (gw.worker.inputs.get(thread.id) ?? []).slice(1);
      const textOfA = edited === "" ? "A2" : "A";
      if (reordered === "") expect(ran).toEqual(["C", textOfA, "B"]);
      else {
        // The scheduler took A first (it may even have finished already); the rest kept the order they had.
        expect(reordered).toMatch(/already started|no longer queued/);
        expect(ran[0]).toBe(textOfA);
        expect(ran.slice(1)).toEqual(["B", "C"]);
      }
      if (edited !== "") expect(edited).toMatch(/already started|no longer queued/);
    }
  }, 60_000);

  test("the scheduler starts a head only as it read it (whileHead)", async () => {
    const { thread, runningId, queued } = await busyThread("while-head", ["A", "B"]);
    const [a, b] = queued.map((t) => t.id) as [string, string];
    const start = (turnId: string, revision: number) =>
      gw.runtime.runPromise(QueueStore.use((q) => q.whileHead({ threadId: thread.id, turnId, revision }, Effect.succeed("started"))));
    expect(await start(a, 0)).toBe("started");
    expect(await start(b, 0)).toBeUndefined(); // not the head
    await gw.api.editQueuedTurn({ turnId: a, text: "A2", expectedRevision: 0 });
    expect(await start(a, 0)).toBeUndefined(); // read before the edit
    expect(await start(a, 1)).toBe("started");
    await gw.api.reorderQueuedTurns({ threadId: thread.id, turnIds: [b, a] });
    expect(await start(a, 1)).toBeUndefined(); // moved down meanwhile
    expect(await drain(thread.id, runningId, 2)).toEqual(["B", "A2"]);
  });

  test("composer settings: the default delivery while a turn runs", async () => {
    const current = await gw.api.getSettings({});
    expect(current.user?.composer?.runningDelivery).toBe(ui.MessageDelivery.UNSPECIFIED);
    const saved = await gw.api.updateUserSettings({ composer: { runningDelivery: ui.MessageDelivery.QUEUE }, expectedVersion: current.user!.version });
    expect(saved.settings?.composer?.runningDelivery).toBe(ui.MessageDelivery.QUEUE);
    expect((await gw.api.getSettings({})).user?.composer?.runningDelivery).toBe(ui.MessageDelivery.QUEUE);
    expect(await failure(gw.api.updateUserSettings({ composer: { runningDelivery: 9 as ui.MessageDelivery }, expectedVersion: saved.settings!.version }))).toContain(
      "unknown message delivery",
    );
  });
});

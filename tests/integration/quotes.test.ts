/**
 * Quotes end to end on PostgreSQL (docs/ui-api.md, "Cytaty"): a message quotes passages of the thread with
 * comments; the agent gets them in the platform note before the user's text (StartTurn and SteerTurn), and the
 * UI gets them structured on the turn and the steer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PermissionMode, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { quotesNote } from "@canopy/domain";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
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
  query<{ id: string; status: string; text: string }>(
    "SELECT id, status, input->>'text' AS text FROM turns WHERE thread_id = $1::uuid ORDER BY ordinal",
    threadId,
  );

const steers = (threadId: string) =>
  query<{ id: string; status: string; queued_turn_id: string | null }>(
    "SELECT id, status, queued_turn_id FROM turn_steers WHERE thread_id = $1::uuid ORDER BY created_at",
    threadId,
  );

async function newThread(title: string, initialMessage = "") {
  return (
    await gw.api.createThread({
      projectId,
      workspaceId,
      title,
      provider: Provider.CODEX,
      permissionMode: PermissionMode.ASK,
      clientRequestId: `create-${title}`,
      initialMessage,
    })
  ).thread!;
}

async function runningThread(title: string) {
  gw.worker.holdTurns = true;
  const thread = await newThread(title, "long task");

  const [turn] = await eventually(
    () => turns(thread.id),
    (t) => t[0]?.status === "running",
  );

  return { thread, turnId: turn!.id };
}

const answer = {
  text: "Dostępność i ruch: pełna obsługa.\nDruga linia.",
  comment: "Skróć to.",
  sourceItemId: "item-a",
  sourceKind: "agent_message",
};

const output = { text: "FAIL src/a.test.ts", sourceItemId: "item-b", sourceKind: "command_output" };
const expectedNote = quotesNote([answer, output]);

describe.skipIf(!dockerAvailable)("quotes (gateway + scripted worker)", () => {
  beforeAll(async () => {
    gw = await startTestGateway();
    projectId = (await gw.api.createProject({ name: "Quotes" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/app", label: "" }))
      .workspace!.id;
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  test("a queued message: StartTurn gets the quotes' note and then the text; the turn keeps them structured", async () => {
    gw.worker.holdTurns = false;
    const thread = await newThread("queued", "first");
    await eventually(
      () => turns(thread.id),
      (t) => t[0]?.status === "completed",
    );

    const sent = await gw.api.sendMessage({
      threadId: thread.id,
      text: "Popraw oba miejsca.",
      clientRequestId: "q-1",
      quotes: [{ ...answer, sourceThreadId: thread.id }, output],
    });

    const turn = sent.turn!;
    expect([turn.messageText, turn.platformNote, turn.inputText]).toEqual([
      "Popraw oba miejsca.",
      expectedNote,
      `${expectedNote}\n\nPopraw oba miejsca.`,
    ]);
    expect(turn.quotes.map((q) => [q.text, q.comment, q.sourceItemId, q.sourceThreadId, q.sourceKind])).toEqual([
      [answer.text, "Skróć to.", "item-a", thread.id, "agent_message"],
      [output.text, "", "item-b", "", "command_output"],
    ]);
    await eventually(
      () => turns(thread.id),
      (t) => t[1]?.status === "completed",
    );
    expect(gw.worker.inputs.get(thread.id)?.[1]).toBe(`${expectedNote}\n\nPopraw oba miejsca.`);
    expect(gw.worker.inputs.get(thread.id)?.[1]).toContain("```text\nFAIL src/a.test.ts\n```");

    // The thread's snapshot carries them too (a reload shows the quotes in the bubble).
    const updates = await watchUntil(gw.api, thread.id, (u) => u.length >= 1);
    const snapshot = updates[0]!.change.case === "snapshot" ? updates[0]!.change.value : undefined;
    expect(snapshot?.turns[1]?.quotes.map((q) => q.sourceItemId)).toEqual(["item-a", "item-b"]);

    // Quotes alone are a message; the agent gets only the note.
    const only = await gw.api.sendMessage({ threadId: thread.id, text: "", clientRequestId: "q-2", quotes: [output] });
    expect([only.turn?.messageText, only.turn?.inputText]).toEqual(["", quotesNote([output])]);
  });

  test("quotes are checked: count, empty text, unknown source kind", async () => {
    const thread = await newThread("checked");

    const send = (quotes: { text: string; sourceKind?: string }[], id: string) =>
      gw.api.sendMessage({ threadId: thread.id, text: "x", clientRequestId: id, quotes });

    expect(await failure(send([{ text: "  " }], "c-1"))).toContain("quote 1 is empty");
    expect(await failure(send([{ text: "a", sourceKind: "image" }], "c-2"))).toContain('unknown source kind "image"');
    expect(
      await failure(
        send(
          Array.from({ length: 21 }, () => ({ text: "a" })),
          "c-3",
        ),
      ),
    ).toContain("up to 20 quotes");
  });

  test("steer with quotes: SteerTurn carries the note and the text, the steer shows the text with its quotes", async () => {
    gw.worker.steerMode = "accept";
    const { thread, turnId } = await runningThread("steer");

    const sent = await gw.api.sendMessage({
      threadId: thread.id,
      text: "Też to.",
      clientRequestId: "s-1",
      delivery: ui.MessageDelivery.STEER,
      quotes: [answer],
    });

    expect(sent.turn).toBeUndefined();
    expect([sent.steer?.turnId, sent.steer?.text, sent.steer?.quotes.map((q) => q.comment)]).toEqual([
      turnId,
      "Też to.",
      ["Skróć to."],
    ]);
    await eventually(
      () => steers(thread.id),
      (s) => s[0]?.status === "delivered",
    );
    expect(gw.worker.steered.get(sent.steer!.id)).toBe(`${quotesNote([answer])}\n\nTeż to.`);
    gw.worker.finish(thread.id, turnId);
    await eventually(
      () => turns(thread.id),
      (t) => t[0]?.status === "completed",
    );
  });

  test("a steer with quotes that cannot join becomes the next turn with the same quotes", async () => {
    gw.worker.steerMode = "not_running";
    const { thread, turnId } = await runningThread("fallback");

    const sent = await gw.api.sendMessage({
      threadId: thread.id,
      text: "Później.",
      clientRequestId: "f-1",
      delivery: ui.MessageDelivery.STEER,
      quotes: [output],
    });

    const [steer] = await eventually(
      () => steers(thread.id),
      (s) => s[0]?.status === "queued",
    );

    gw.worker.holdTurns = false;
    gw.worker.finish(thread.id, turnId);

    const all = await eventually(
      () => turns(thread.id),
      (t) => t[1]?.status === "completed",
    );

    expect([all[1]?.id, all[1]?.text]).toEqual([steer!.queued_turn_id ?? "", `${quotesNote([output])}\n\nPóźniej.`]);
    const updates = await watchUntil(gw.api, thread.id, (u) => u.length >= 1);
    const snapshot = updates[0]!.change.case === "snapshot" ? updates[0]!.change.value : undefined;
    const fallback = snapshot?.turns.find((t) => t.id === steer!.queued_turn_id);
    expect([fallback?.messageText, fallback?.quotes.map((q) => q.sourceItemId)]).toEqual(["Później.", ["item-b"]]);
    expect(snapshot?.steers.find((s) => s.id === sent.steer!.id)?.quotes).toHaveLength(1);
    gw.worker.steerMode = "accept";
  });
});

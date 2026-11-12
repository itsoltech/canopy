import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MentionKind, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { startInstanceFixture } from "./support/instance-fixture.ts";
import { eventually, failure, watchUntil } from "./support/gateway.ts";
import { inputRecords } from "./fixtures/instance-probe.ts";

describe.skipIf(!dockerAvailable)("inline citations (gateway, real worker and fake CLIs)", () => {
  let fixture: Awaited<ReturnType<typeof startInstanceFixture>>;
  beforeAll(async () => {
    fixture = await startInstanceFixture();

    for (const provider of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) await fixture.save(provider, "citations");
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });

  for (const [provider, harness] of [
    [Provider.CLAUDE, "claude"],
    [Provider.CODEX, "codex"],
    [Provider.GROK, "grok"],
  ] as const) {
    test(`${harness}: positions, storage, reload and the harness input agree; old clients retain their note`, async () => {
      const thread = await fixture.thread(provider);
      const text = "Before [first] between [second] after [third] end.";

      const quotes = [
        { text: "First passage 🪴", start: 7, end: 14, sourceKind: "agent_message", sourceThreadId: thread.id },
        {
          text: "line one\n  line two",
          start: 23,
          end: 31,
          sourceKind: "code",
          language: "ts",
          sourceThreadId: thread.id,
        },
        {
          text: "Third passage",
          start: 38,
          end: 45,
          comment: "Consider this",
          sourceKind: "reasoning",
          sourceThreadId: thread.id,
        },
      ];

      const sent = await fixture.gw.api.sendMessage({
        threadId: thread.id,
        text,
        quotes: [...quotes].reverse(),
        clientRequestId: crypto.randomUUID(),
      });

      const completed = await fixture.finished(thread.id, sent.turn!.id);
      expect(completed.status).toBe("completed");
      expect(completed.messageText).toBe(text);
      expect(completed.quotes.map((q) => [q.text, q.start, q.end])).toEqual(
        quotes.map((q) => [q.text, q.start, q.end]),
      );

      const expected =
        "Before \n\n[canopy citation 1]\n> First passage 🪴\n[/canopy citation 1]\n\n between \n\n[canopy citation 2]\n```ts\nline one\n  line two\n```\n[/canopy citation 2]\n\n after \n\n[canopy citation 3]\n> Third passage\n\nComment: Consider this\n[/canopy citation 3]\n\n end.";

      expect(completed.inputText).toBe(expected);

      const delivered = inputRecords(fixture.trace)
        .filter((record) => record.harness === harness)
        .at(-1)!;

      expect(
        delivered.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      ).toContain(expected);

      const snapshots = await watchUntil(fixture.gw.api, thread.id, (updates) =>
        updates.some((u) => u.change.case === "snapshot"),
      );

      const snapshot = snapshots.find((u) => u.change.case === "snapshot")!;

      if (snapshot.change.case !== "snapshot") throw new Error("missing snapshot");
      expect(snapshot.change.value.turns.find((turn) => turn.id === completed.id)?.quotes.map((q) => q.start)).toEqual([
        7, 23, 38,
      ]);

      const legacy = await fixture.gw.api.sendMessage({
        threadId: thread.id,
        text: "Old message",
        quotes: [{ text: "Old quote", sourceKind: "agent_message" }],
        clientRequestId: crypto.randomUUID(),
      });

      const old = await fixture.finished(thread.id, legacy.turn!.id);
      expect(old.inputText).toContain("Quote 1, from your message:\n> Old quote\n\nOld message");
      expect(old.quotes[0]?.start).toBeUndefined();
    }, 30_000);
  }

  test("citation expansion preserves native mention ranges through all three harnesses", async () => {
    for (const provider of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) {
      const thread = await fixture.thread(provider);
      const text = "Before [a] then @README.md after [b].";

      const sent = await fixture.gw.api.sendMessage({
        threadId: thread.id,
        text,
        clientRequestId: crypto.randomUUID(),
        mentions: [{ kind: MentionKind.FILE, name: "README.md", start: 16, end: 26 }],
        quotes: [
          { text: "First passage", start: 7, end: 10 },
          { text: "Second passage", start: 33, end: 36 },
        ],
      });

      const turn = await fixture.finished(thread.id, sent.turn!.id);
      expect(turn.status).toBe("completed");

      const [stored] = await fixture.query<{ input: { text: string; delivered: { start: number; end: number }[] } }>(
        "SELECT input FROM turns WHERE id=$1::uuid",
        [turn.id],
      );

      expect(stored!.input.delivered.map((m) => stored!.input.text.slice(m.start, m.end))).toEqual(["@README.md"]);

      const textPart = inputRecords(fixture.trace)
        .at(-1)!
        .parts.filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");

      expect(textPart).toContain(turn.inputText);
      expect(turn.inputText.indexOf("First passage")).toBeLessThan(turn.inputText.lastIndexOf("@README.md"));
      expect(turn.inputText.indexOf("Second passage")).toBeGreaterThan(turn.inputText.lastIndexOf("@README.md"));
    }
  }, 30_000);

  test("queued edits relocate old markers, replace and remove citations before delivery", async () => {
    const thread = await fixture.thread(Provider.CODEX);
    const held = await fixture.send(thread.id, "HOLD:citations-queue");
    await eventually(
      () => fixture.gw.api.getThread({ threadId: thread.id }),
      (r) => r.thread?.status === "running",
    );

    const sent = (
      await fixture.gw.api.sendMessage({
        threadId: thread.id,
        text: "A [q] B",
        quotes: [{ text: "Original", start: 2, end: 5 }],
        clientRequestId: crypto.randomUUID(),
      })
    ).turn!;

    const moved = (
      await fixture.gw.api.editQueuedTurn({
        turnId: sent.id,
        text: "Prefix A [q] B",
        expectedRevision: sent.revision,
      })
    ).turn!;

    expect(moved.quotes[0]?.start).toBe(9);

    const edited = (
      await fixture.gw.api.editQueuedTurn({
        turnId: sent.id,
        text: "[q] Finally",
        expectedRevision: moved.revision,
        quotesComplete: true,
        quotes: [{ text: "Edited quote", start: 0, end: 3 }],
      })
    ).turn!;

    expect(edited.inputText).toContain("> Edited quote\n[/canopy citation 1]\n\n Finally");

    const removed = (
      await fixture.gw.api.editQueuedTurn({
        turnId: sent.id,
        text: "Finally",
        expectedRevision: edited.revision,
        quotesComplete: true,
      })
    ).turn!;

    expect(removed.quotes).toHaveLength(0);
    expect(removed.inputText).toBe("Finally");
    await fixture.release("citations-queue");
    await fixture.finished(thread.id, held.id);
    expect((await fixture.finished(thread.id, sent.id)).inputText).toBe("Finally");
    expect(inputRecords(fixture.trace).at(-1)!.parts).toContainEqual({ type: "text", text: "Finally" });
  }, 30_000);

  test("foreign and missing source threads are rejected before persistence or delivery", async () => {
    const thread = await fixture.thread(Provider.CODEX);
    const foreign = Bun.randomUUIDv7();
    const foreignThread = Bun.randomUUIDv7();
    await fixture.query("INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,$2,'Other','user')", [
      foreign,
      `${foreign}@example.test`,
    ]);
    await fixture.query(
      `INSERT INTO threads(id,root_thread_id,owner_user_id,project_id,kind,runtime,provider,worker_id,workspace_id,cwd,status,title)
      SELECT $1::uuid,$1::uuid,$2::uuid,project_id,kind,runtime,provider,worker_id,workspace_id,cwd,status,title FROM threads WHERE id=$3::uuid`,
      [foreignThread, foreign, thread.id],
    );
    const before = inputRecords(fixture.trace).length;

    for (const sourceThreadId of [foreignThread, Bun.randomUUIDv7()]) {
      expect(
        await failure(
          fixture.gw.api.sendMessage({
            threadId: thread.id,
            text: "[quote]",
            quotes: [{ text: "Private passage", start: 0, end: 7, sourceThreadId }],
            clientRequestId: crypto.randomUUID(),
          }),
        ),
      ).toContain("citation source not found");
    }

    expect(await fixture.query("SELECT id FROM turns WHERE thread_id=$1::uuid", [thread.id])).toHaveLength(0);
    expect(inputRecords(fixture.trace)).toHaveLength(before);
  });

  test("overlapping, incomplete and out-of-text citation ranges are rejected", async () => {
    const thread = await fixture.thread(Provider.CODEX);

    for (const quotes of [
      [{ text: "x", start: 0 }],
      [{ text: "x", start: 0, end: 50 }],
      [
        { text: "x", start: 0, end: 2 },
        { text: "y", start: 1, end: 3 },
      ],
    ])
      expect(
        await failure(
          fixture.gw.api.sendMessage({
            threadId: thread.id,
            text: "[x]",
            quotes,
            clientRequestId: crypto.randomUUID(),
          }),
        ),
      ).toContain("range");
  });
});

import { expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { ItemStatus, NoticeLevel, ui } from "@canopy/contracts";
import { noticePresentation } from "@canopy/domain/notice-presentation";
import { turnNotices } from "@canopy/domain/turn-notices";
import { turnBody } from "../../mobile/src/features/timeline/turn-plan.ts";
import { FeedBuilder, type FeedInput } from "../src/lib/features/threads/feed.ts";
import { planFolds } from "../src/lib/features/threads/work-segments.ts";

const message = JSON.stringify({
  type: "error",
  status: 400,
  error: { message: "no active upstream websocket for response.interrupt" },
});

function fixture() {
  return create(ui.ThreadSnapshotSchema, {
    turns: [
      {
        id: "turn",
        ordinal: 1,
        status: "completed",
        startedAt: timestampFromMs(1000),
        completedAt: timestampFromMs(9000),
      },
    ],
    items: [
      {
        turnId: "turn",
        firstSeq: 1n,
        item: { itemId: "work", status: ItemStatus.COMPLETED, content: { case: "reasoning", value: { text: "Work" } } },
      },
      {
        turnId: "turn",
        firstSeq: 5n,
        item: {
          itemId: "answer",
          status: ItemStatus.COMPLETED,
          content: { case: "agentMessage", value: { text: "Done", phase: "final_answer" } },
        },
      },
    ],
    notices: [2n, 3n, 4n].map((seq) => ({
      seq,
      turnId: "",
      occurredAt: timestampFromMs(Number(seq) * 1000),
      notice: {
        level: NoticeLevel.ERROR,
        code: "httpConnectionFailed",
        message,
        dataJson: '{"additionalDetails":"Retried"}',
      },
    })),
  });
}

function input(state: ui.ThreadSnapshot, open: boolean): FeedInput {
  return {
    entries: state.items.flatMap((entry) =>
      entry.item ? [{ ...entry, id: entry.item.itemId, item: entry.item }] : [],
    ),
    turns: state.turns,
    notices: state.notices.flatMap((n) => (n.notice ? [{ ...n, notice: n.notice, at: n.occurredAt }] : [])),
    results: new Map(),
    steering: [],
    working: false,
    inheritedEntries: [],
    inheritedTurns: [],
    historyOpen: false,
    openWork: new Set(open ? ["turn", "turn/1"] : []),
  };
}

test("recovered diagnostics share their chronological work position and count on web, mobile and reload", () => {
  const state = fixture();
  const saved = fromBinary(ui.ThreadSnapshotSchema, toBinary(ui.ThreadSnapshotSchema, state));

  for (const snapshot of [state, saved]) {
    const notices = turnNotices(snapshot.notices, snapshot.turns, snapshot.items);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ turnId: "turn", seq: 2n, count: 3, recovered: true });
    expect(snapshot.notices.map((notice) => notice.turnId)).toEqual(["", "", ""]);
    const shown = noticePresentation(notices[0]!.notice!, notices[0]);
    expect(shown).toMatchObject({ level: NoticeLevel.WARNING, count: 3 });
    expect(shown.message).not.toContain("response.interrupt");
    expect(shown.details).toContain("response.interrupt");
    expect(shown.details).toContain("Retried");
    const body = turnBody(snapshot.turns[0]!, snapshot.items, notices);
    expect(body.map((row) => row.key)).toEqual(["item:work", "notice:2", "item:answer"]);

    const data = input(snapshot, true);
    const rows = new FeedBuilder().build(data);
    const warning = rows.findIndex((row) => row.kind === "timeline" && row.row.kind === "notice");
    expect(rows[warning]).toMatchObject({ work: true, row: { notice: { count: 3, recovered: true } } });
    expect(rows[warning - 1]).toMatchObject({ key: "item:work" });
    expect(rows[warning + 1]).toMatchObject({ key: "answer:turn" });
    expect(rows.at(-1)).toMatchObject({ key: "end:turn" });
    expect(planFolds(data.turns, data.entries, data.notices).workOf.get("notice:2")).toBe("turn");
    expect(
      new FeedBuilder()
        .build(input(snapshot, false))
        .some((row) => row.kind === "timeline" && row.row.kind === "notice"),
    ).toBe(false);
  }
});

test("incremental completion changes severity and late old-turn errors invalidate the completed feed prefix", () => {
  const state = fixture();
  const builder = new FeedBuilder();
  const running = { ...state, turns: [{ ...state.turns[0]!, status: "running", completedAt: undefined }] };
  const before = turnNotices(running.notices, running.turns, running.items);
  expect(before[0]?.recovered).toBe(false);
  builder.build(input(running, true));
  state.turns.push(
    create(ui.TurnSchema, { id: "next", ordinal: 2, status: "running", startedAt: timestampFromMs(10000) }),
  );
  const settled = builder.build(input(state, true));
  expect(settled.find((row) => row.kind === "timeline" && row.row.kind === "notice")).toMatchObject({
    row: { notice: { recovered: true } },
  });
  state.notices.push(
    create(ui.ThreadNoticeSchema, {
      ...state.notices[0]!,
      turnId: "turn",
      seq: 8n,
      occurredAt: timestampFromMs(12000),
    }),
  );
  const rows = builder.build(input(state, true));

  const late = rows.findIndex(
    (row) => row.kind === "timeline" && row.row.kind === "notice" && row.row.notice.seq === 8n,
  );

  expect(late).toBeGreaterThan(-1);
  expect(rows.findIndex((row) => row.key === "end:turn")).toBeGreaterThan(late);
  expect(rows.findIndex((row) => row.key === "work:next")).toBeGreaterThan(late);
});

test("failed turns retain error severity; ambiguous, unknown and out-of-window notices are never reassigned", () => {
  const state = fixture();
  const failed = [{ ...state.turns[0]!, status: "failed", error: message }];
  const notices = turnNotices(state.notices, failed, state.items);
  expect(notices[0]?.recovered).toBe(false);
  expect(noticePresentation(notices[0]!.notice!, notices[0]).level).toBeUndefined();
  expect(new FeedBuilder().build(input({ ...state, turns: failed }, false)).at(-1)).toMatchObject({
    row: { turn: { status: "failed", error: message } },
  });
  expect(turnNotices(state.notices, [...failed, { ...failed[0]!, id: "overlap" }], state.items)[0]?.turnId).toBe("");
  const unknown = state.notices.map((n) => ({ ...n, turnId: "outside-window" }));
  expect(turnNotices(unknown, failed, state.items)[0]?.turnId).toBe("outside-window");
  expect(
    new FeedBuilder()
      .build(input({ ...state, notices: unknown }, true))
      .some((row) => row.kind === "timeline" && row.row.kind === "notice"),
  ).toBe(false);
  const late = state.notices.map((n) => ({ ...n, occurredAt: timestampFromMs(11000) }));
  expect(turnNotices(late, failed, state.items)[0]?.turnId).toBe("");
});

test("sequence fallback and segment boundaries preserve distinct warnings and memoized row identity", () => {
  const state = fixture();
  const legacy = state.notices.map((n) => ({ ...n, occurredAt: undefined }));
  const first = turnNotices(legacy, state.turns, state.items);
  expect(first[0]).toMatchObject({ turnId: "turn", count: 3 });
  expect(turnNotices(legacy, state.turns, state.items)[0]).toBe(first[0]);

  const different = {
    ...legacy[0]!,
    seq: 6n,
    turnId: "turn",
    notice: { ...legacy[0]!.notice!, dataJson: "different detail" },
  };

  const repeated = { ...legacy[0]!, seq: 7n, turnId: "turn" };
  expect(turnNotices([...legacy, different, repeated], state.turns, state.items)).toHaveLength(3);
});

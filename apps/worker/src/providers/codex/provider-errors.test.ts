import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ItemStatus, NoticeLevel, ThreadEventSchema, TurnEndSource, TurnOutcome, ui } from "@canopy/contracts";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { noticePresentation } from "@canopy/domain/notice-presentation";
import { CodexEventMapper } from "./mapping.ts";
import { commentary, completed, errorTurn, INTERRUPT_ERROR, turn, turnError } from "./fixtures/provider-errors.ts";

function harness() {
  const ids = new Map<string, string>();

  const mapper = new CodexEventMapper({
    startTurn: (id) => ids.get(id) ?? ids.set(id, Bun.randomUUIDv7()).get(id)!,
    turnId: (id) => ids.get(id),
    isCommandTurn: () => true,
  });

  let state = create(ui.ThreadSnapshotSchema);
  let seq = 0n;

  const record = (notification: Parameters<CodexEventMapper["map"]>[0]) => {
    const events = mapper.map(notification).map((init) =>
      create(ThreadEventSchema, {
        turnId: init.turnId ?? "",
        body: init.body ?? { case: undefined },
        rawJson: init.rawJson ?? "",
      }),
    );

    for (const event of events)
      state = applyThreadUpdate(
        state,
        create(ui.ThreadUpdateSchema, {
          change: { case: "event", value: { seq: ++seq, event } },
        }),
      );

    return events;
  };

  return {
    record,
    get state() {
      return state;
    },
  };
}

for (const willRetry of [false, true])
  test(`a provider notice (willRetry=${willRetry}) and more work leave the turn running until completion`, () => {
    const h = harness();

    for (const notification of errorTurn("thread", "turn", willRetry)) {
      expect(h.record(notification).every((e) => e.body.case !== "turnFinished")).toBe(true);
      expect(h.state.turns[0]?.status).toBe("running");
    }

    const notice = h.state.notices[0]!.notice!;
    expect(notice.level).toBe(willRetry ? NoticeLevel.WARNING : NoticeLevel.ERROR);
    expect(notice.message).toBe(INTERRUPT_ERROR);
    expect(noticePresentation(notice)).toMatchObject({
      message: "Provider error 400: no active upstream websocket for response.interrupt",
      details: expect.stringContaining('"invalid_request_error"'),
    });
    expect(h.state.items[0]?.item?.status).toBe(ItemStatus.COMPLETED);
    expect(h.record(completed("thread", "turn"))[0]?.body.value).toMatchObject({ outcome: TurnOutcome.COMPLETED });
    expect(h.state.turns[0]).toMatchObject({ status: "completed", error: "", errorSource: "", errorCode: "" });
  });

test("provider diagnostics redact endpoints and credentials in the summary and expanded details", () => {
  const h = harness();
  h.record({ method: "turn/started", params: { threadId: "thread", turn: turn("turn") } });
  h.record({
    method: "error",
    params: {
      threadId: "thread",
      turnId: "turn",
      willRetry: false,
      error: {
        ...turnError,
        message: JSON.stringify({
          type: "error",
          status: 400,
          error: { message: "Request to https://provider.example/v1 failed; api_key=fixture-private-key" },
          access_token: "fixture-private-token",
        }),
        additionalDetails: "Bearer fixture-private-bearer",
      },
    },
  });
  const presentation = noticePresentation(h.state.notices[0]!.notice!);
  expect(presentation.message).toContain("Provider error 400:");
  expect(presentation.details).toContain("[redacted]");
  expect(JSON.stringify(presentation)).not.toMatch(/provider\.example|fixture-private/);
  expect(h.state.turns[0]?.status).toBe("running");
});

test("a terminal failure belongs to its own turn across a wake-up and late old-turn output", () => {
  const h = harness();

  for (const n of errorTurn("thread", "failed", false)) h.record(n);
  const failure = h.record(completed("thread", "failed", "failed"));
  expect(failure.at(-1)?.body.value).toMatchObject({
    outcome: TurnOutcome.FAILED,
    source: TurnEndSource.HARNESS,
    errorCode: "httpConnectionFailed:400",
    reason: INTERRUPT_ERROR,
  });
  h.record({ method: "turn/started", params: { threadId: "thread", turn: turn("wake") } });
  h.record(commentary("thread", "wake", "Handling the background task completion"));
  h.record(commentary("thread", "failed", "Late old-turn diagnostic"));
  h.record(completed("thread", "failed", "failed"));
  expect(h.state.turns.map((t) => t.status)).toEqual(["failed", "running"]);
  expect(h.state.items.at(-1)?.turnId).toBe(h.state.turns[0]?.id);
  h.record(completed("thread", "wake"));
  expect(h.state.turns.map((t) => t.status)).toEqual(["failed", "completed"]);
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { CommandSchema, NoticeLevel, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { noticePresentation } from "@canopy/domain/notice-presentation";
import { turnNotices } from "@canopy/domain/turn-notices";
import { startInstanceFixture, type InstanceFixture } from "./support/instance-fixture.ts";
import { followThread } from "./support/thread-watch.ts";
import { eventually, watchUntil } from "./support/gateway.ts";

const providerNotices = (state: ui.ThreadSnapshot) =>
  state.notices.filter((entry) => entry.notice?.code === "httpConnectionFailed");

describe.skipIf(!dockerAvailable)("Codex provider warnings through the gateway↔worker link", () => {
  let f: InstanceFixture;
  beforeAll(async () => {
    f = await startInstanceFixture();
    await f.save(Provider.CODEX, "provider-warnings");
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });

  test("a background note uses steer without Stop; recovered errors keep their turn through live sync and reload", async () => {
    const thread = await f.thread(Provider.CODEX);
    const background = await f.send(thread.id, "BACKGROUND");
    await f.finished(thread.id, background.id);
    const running = await f.send(thread.id, "HOLD:provider-warnings");
    const abort = new AbortController();
    const live = await followThread(f.gw.api.watchThread({ threadId: thread.id }, { signal: abort.signal }), abort);

    try {
      await live.until((state) => state.turns.some((turn) => turn.id === running.id && turn.status === "running"));
      // Gateway dispatch precedes native admission, including connector inventory checks.
      expect(
        await eventually(async () => f.host.runningTurns().some((turn) => turn.turnId === running.id), Boolean),
      ).toBe(true);
      await f.release("background");
      await live.until(
        (state) =>
          providerNotices(state).length === 3 &&
          state.steers.some((steer) => steer.backgroundItemIds.length > 0 && steer.status === "delivered"),
      );
      expect(providerNotices(live.state).every((notice) => notice.turnId === running.id)).toBe(true);
      expect(live.state.turns.find((turn) => turn.id === running.id)?.status).toBe("running");
      await f.release("provider-warnings");
      await live.until((state) => state.turns.find((turn) => turn.id === running.id)?.status === "completed");

      const check = (state: ui.ThreadSnapshot) => {
        const notices = turnNotices(providerNotices(state), state.turns, state.items);
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({ turnId: running.id, recovered: true, count: 3 });
        expect(noticePresentation(notices[0]!.notice!, notices[0])).toMatchObject({
          level: NoticeLevel.WARNING,
          count: 3,
        });
        expect(state.turns.find((turn) => turn.id === running.id)).toMatchObject({ status: "completed", error: "" });
      };

      check(live.state);
      const updates = await watchUntil(f.gw.api, thread.id, (all) => all.some((u) => u.change.case === "snapshot"));
      const snapshot = updates[0]!.change;

      if (snapshot.case !== "snapshot") throw new Error("Expected a snapshot");
      check(snapshot.value);
      expect(
        f.records().filter((record) => record.event === "turn/interrupt" && record.session === thread.providerThreadId),
      ).toHaveLength(0);
      expect(
        f.records().filter((record) => record.event === "turn/steer" && record.session === thread.providerThreadId),
      ).toHaveLength(1);

      // An outbox command overtaken by completion must not reach app-server, even when redelivered.
      for (const kind of [
        { case: "interruptTurn" as const, value: { threadId: thread.id, turnId: running.id } },
        {
          case: "steerTurn" as const,
          value: {
            threadId: thread.id,
            turnId: running.id,
            inputId: crypto.randomUUID(),
            input: { text: "Late note" },
          },
        },
      ]) {
        const result = await f.host.handleCommand(create(CommandSchema, { commandId: crypto.randomUUID(), kind }));
        expect(result?.ok).toBe(false);
        expect(result?.errorCode).toBe(kind.case === "interruptTurn" ? "TURN_NOT_RUNNING" : "STEER_NOT_RUNNING");
      }

      await eventually(
        async () => f.host.runningTurns().length,
        (count) => count === 0,
      );
      expect(
        f.records().some((record) => record.event === "turn/interrupt" && record.session === thread.providerThreadId),
      ).toBe(false);
    } finally {
      await f.release("provider-warnings");
      await live.close();
    }
  }, 30_000);
});

/** Live permissions cross gRPC, WorkerHost and the real Claude SDK, with a scripted CLI and no model. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { CommandSchema, InteractionKind, PermissionMode, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { permissionRecords } from "./fixtures/instance-permissions.ts";
import { eventually, failure } from "./support/gateway.ts";
import { startInstanceFixture, type InstanceFixture } from "./support/instance-fixture.ts";
import { followThread } from "./support/thread-watch.ts";

describe.skipIf(!dockerAvailable)("Claude live permissions through the real SDK", () => {
  let f: InstanceFixture;

  beforeAll(async () => {
    f = await startInstanceFixture();
    await f.save(Provider.CLAUDE, "live-permissions");
  }, 60_000);

  afterAll(async () => {
    await f?.close();
  });

  const processOf = (session: string) => f.records().filter((r) => r.session === session && r.event === "spawn");
  const controls = (session: string) => permissionRecords(f.trace).filter((r) => r.session === session);

  test("Full auto becomes Full access in the same turn and process, with the sandbox disabled explicitly", async () => {
    const thread = await f.thread(Provider.CLAUDE);

    const turn = (
      await f.gw.api.sendMessage({
        threadId: thread.id,
        text: "HOLD:live-sandbox",
        clientRequestId: crypto.randomUUID(),
        permissionMode: PermissionMode.FULL_AUTO,
      })
    ).turn!;

    const abort = new AbortController();
    const watch = await followThread(f.gw.api.watchThread({ threadId: thread.id }, { signal: abort.signal }), abort);

    try {
      await eventually(
        async () => f.records().filter((r) => r.session === thread.providerThreadId && r.event === "turn"),
        (rows) => rows.length === 1,
      );
      const before = processOf(thread.providerThreadId);
      expect(before).toHaveLength(1);

      const changed = await f.gw.api.updateTurnPermissions({
        threadId: thread.id,
        turnId: turn.id,
        permissionMode: PermissionMode.FULL_ACCESS,
      });

      expect(changed.turn?.permissionMode).toBe(PermissionMode.FULL_ACCESS);
      await watch.until((s) =>
        s.turns.some((t) => t.id === turn.id && t.permissionMode === PermissionMode.FULL_ACCESS),
      );
      const sent = controls(thread.providerThreadId);
      const disabled = sent.findIndex((r) => r.event === "sandbox" && r.enabled === false);
      expect(disabled).toBeGreaterThanOrEqual(0);
      expect(sent.slice(disabled + 1)).toContainEqual(expect.objectContaining({ event: "mode", mode: "acceptEdits" }));
      expect(sent.every((r) => r.pid === before[0]!.pid)).toBe(true);
      expect(processOf(thread.providerThreadId)).toEqual(before);
      expect((await f.gw.api.getThread({ threadId: thread.id })).thread?.permissionMode).toBe(PermissionMode.ASK);

      await f.release("live-sandbox");
      expect((await f.finished(thread.id, turn.id)).permissionMode).toBe(PermissionMode.FULL_ACCESS);
      expect(
        await failure(
          f.gw.api.updateTurnPermissions({ threadId: thread.id, turnId: turn.id, permissionMode: PermissionMode.ASK }),
        ),
      ).toContain("running");
    } finally {
      await f.release("live-sandbox");
      await watch.close();
    }
  }, 60_000);

  test("an applied permission change replays after a lost link and command reply", async () => {
    const thread = await f.thread(Provider.CLAUDE);

    const turn = (
      await f.gw.api.sendMessage({
        threadId: thread.id,
        text: "HOLD:live-replay",
        clientRequestId: crypto.randomUUID(),
        permissionMode: PermissionMode.FULL_AUTO,
      })
    ).turn!;

    await eventually(
      async () => f.records().filter((r) => r.session === thread.providerThreadId && r.event === "turn"),
      (rows) => rows.length === 1,
    );
    const before = processOf(thread.providerThreadId);
    await f.disconnect();

    try {
      // The worker received the command before losing its link; neither its event nor reply can reach the gateway.
      const command = create(CommandSchema, {
        commandId: crypto.randomUUID(),
        kind: {
          case: "updateTurnPermissions",
          value: { threadId: thread.id, turnId: turn.id, permissionMode: PermissionMode.FULL_ACCESS },
        },
      });

      expect((await f.host.handleCommand(command))?.ok).toBe(true);
      const settings = controls(thread.providerThreadId);

      const stored = () =>
        f.query<{ permission_mode: string }>("SELECT permission_mode FROM turns WHERE id=$1", [turn.id]);

      expect((await stored())[0]?.permission_mode).toBe("FULL_AUTO");

      await f.reconnect();
      await eventually(stored, (rows) => rows[0]?.permission_mode === "FULL_ACCESS");
      // Reconnecting replays the journaled outcome, never the transient control command.
      await f.disconnect();
      await f.reconnect();
      expect(controls(thread.providerThreadId)).toEqual(settings);
      expect(processOf(thread.providerThreadId)).toEqual(before);
      await f.release("live-replay");
      expect((await f.finished(thread.id, turn.id)).permissionMode).toBe(PermissionMode.FULL_ACCESS);
    } finally {
      await f.release("live-replay");
    }
  }, 60_000);

  test("Full access releases a pending permission, preserves its question and auto-allows subsequent tools", async () => {
    const thread = await f.thread(Provider.CLAUDE);
    const abort = new AbortController();
    const watch = await followThread(f.gw.api.watchThread({ threadId: thread.id }, { signal: abort.signal }), abort);

    try {
      const turn = await f.send(thread.id, "LIVE_PERMISSIONS");
      await watch.until(
        (s) => s.interactions.filter((i) => i.turnId === turn.id && i.status === "pending").length === 2,
      );
      const pending = watch.state!.interactions.filter((i) => i.turnId === turn.id && i.status === "pending");
      const permission = pending.find((i) => i.kind === InteractionKind.PERMISSION)!;
      const question = pending.find((i) => i.kind === InteractionKind.QUESTION)!;
      expect(permission.toolName).toBe("Bash");
      expect(question.toolName).toBe("AskUserQuestion");
      const before = processOf(thread.providerThreadId);
      expect(before).toHaveLength(1);

      await f.gw.api.updateTurnPermissions({
        threadId: thread.id,
        turnId: turn.id,
        permissionMode: PermissionMode.FULL_ACCESS,
      });
      await watch.until((s) =>
        s.interactions.some((i) => i.requestId === permission.requestId && i.status === "allowed"),
      );
      await eventually(
        async () => controls(thread.providerThreadId),
        (rows) => rows.some((r) => r.event === "permission" && r.behavior === "allow"),
      );
      expect(watch.state!.interactions.find((i) => i.requestId === question.requestId)?.status).toBe("pending");
      expect(controls(thread.providerThreadId).some((r) => r.event === "question")).toBe(false);

      await f.gw.api.answerInteraction({
        requestId: question.requestId,
        answerJson: '{"Continue the fixture?":"Yes"}',
      });
      expect((await f.finished(thread.id, turn.id)).status).toBe("completed");
      const replies = controls(thread.providerThreadId).filter((r) => r.behavior !== undefined);
      expect(replies.map((r) => [r.event, r.behavior])).toEqual([
        ["permission", "allow"],
        ["question", "allow"],
        ["after-switch", "allow"],
      ]);
      expect(replies.every((r) => r.pid === before[0]!.pid)).toBe(true);
      expect(processOf(thread.providerThreadId)).toEqual(before);
      await watch.until((s) => s.turns.some((t) => t.id === turn.id && t.status === "completed"));
      expect(
        watch.state!.interactions.filter((i) => i.turnId === turn.id && i.kind === InteractionKind.PERMISSION),
      ).toHaveLength(1);
    } finally {
      await watch.close();
    }
  }, 60_000);
});

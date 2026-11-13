import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, toJson } from "@bufbuild/protobuf";
import { CommandSchema, Provider, ProviderProfileKind, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { GatewayStore, InstanceStore } from "@canopy/gateway/store";
import { eventually, failure } from "./support/gateway.ts";
import { startInstanceFixture, type InstanceFixture } from "./support/instance-fixture.ts";

describe.skipIf(!dockerAvailable)("instance changes at turn boundaries over the gateway↔worker link", () => {
  let f: InstanceFixture;
  beforeAll(async () => {
    f = await startInstanceFixture();
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });

  test("Claude serializes concurrent StartTurn deliveries behind a running turn without blocking controls", async () => {
    await f.save(Provider.CLAUDE, "turn-admission");
    const thread = await f.thread(Provider.CLAUDE);
    const held = await f.send(thread.id, "HOLD:admission");
    await eventually(
      async () => f.host.runningTurns(),
      (turns) => turns.some((t) => t.turnId === held.id),
    );

    const running = await eventually(
      async () => f.records().filter((r) => r.session === thread.providerThreadId && r.event === "turn"),
      (rows) => rows.length === 1,
      15_000,
    );

    expect(running).toHaveLength(1);
    const queued = [await f.send(thread.id, "first continuation"), await f.send(thread.id, "second continuation")];

    const spec = await f.gw.runtime.runPromise(
      GatewayStore.use((s) => s.thread(thread.id).pipe(Effect.map((row) => s.threadSpec(row)))),
    );

    // Reproduce two starts admitted by a gateway before it sees the provider's running turn.
    const commands = await Promise.all(
      queued.map((turn) =>
        f.gw.runtime.runPromise(
          GatewayStore.use((s) =>
            s.enqueueCommand({
              workerId: f.workerId,
              threadId: thread.id,
              turnId: turn.id,
              ttlSeconds: 60,
              command: create(CommandSchema, {
                kind: {
                  case: "startTurn",
                  value: {
                    thread: spec,
                    turnId: turn.id,
                    input: { text: turn.inputText },
                  },
                },
              }),
            }),
          ),
        ),
      ),
    );

    const connection = f.gw.core.link.connections.get(f.workerId)!;

    const replies = commands.map((command) => {
      if (command.kind.case !== "startTurn") throw new Error("Expected StartTurn");

      return connection.sendCommand(command.kind, 10_000, command.commandId);
    });

    try {
      // A later command on the same stream crosses the worker while both starts wait.
      await f.gw.api.listDirectory({ workerId: f.workerId, path: f.dir });
      expect(f.records().filter((r) => r.session === thread.providerThreadId && r.event === "turn")).toHaveLength(1);
      await f.release("admission");
      expect((await Promise.all(replies)).map((r) => r.ok)).toEqual([true, true]);

      for (const turn of queued) expect((await f.finished(thread.id, turn.id)).status).toBe("completed");
      expect(
        f
          .records()
          .filter((r) => r.session === thread.providerThreadId && ["turn", "finish"].includes(r.event))
          .map((r) => r.event),
      ).toEqual(["turn", "finish", "turn", "finish", "turn", "finish"]);
      // Lost acknowledgement: the worker journal returns the saved result without executing another turn.
      const first = commands[0]!;

      if (first.kind.case !== "startTurn") throw new Error("Expected StartTurn");
      expect((await connection.sendCommand(first.kind, 10_000, first.commandId)).ok).toBe(true);
      expect(f.records().filter((r) => r.session === thread.providerThreadId && r.event === "turn")).toHaveLength(3);
      await f.restartWorker();
      const restarted = f.gw.core.link.connections.get(f.workerId)!;
      expect((await restarted.sendCommand(first.kind, 10_000, crypto.randomUUID())).ok).toBe(true);
      expect(f.records().filter((r) => r.session === thread.providerThreadId && r.event === "turn")).toHaveLength(3);
    } finally {
      await f.release("admission");
      await Promise.allSettled(replies);
    }
  }, 60_000);

  test("archiving fences a StartTurn waiting at the worker, including after restart", async () => {
    await f.save(Provider.CLAUDE, "cancel-admission");
    const thread = await f.thread(Provider.CLAUDE);
    const held = await f.send(thread.id, "HOLD:cancel-admission");
    await eventually(
      async () => f.records().filter((r) => r.session === thread.providerThreadId && r.event === "turn"),
      (rows) => rows.length === 1,
      15_000,
    );
    const queued = await f.send(thread.id, "must never enter the harness");

    const spec = await f.gw.runtime.runPromise(
      GatewayStore.use((s) => s.thread(thread.id).pipe(Effect.map((row) => s.threadSpec(row)))),
    );

    const command = await f.gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.enqueueCommand({
          workerId: f.workerId,
          threadId: thread.id,
          turnId: queued.id,
          ttlSeconds: 60,
          command: create(CommandSchema, {
            kind: { case: "startTurn", value: { thread: spec, turnId: queued.id, input: { text: queued.inputText } } },
          }),
        }),
      ),
    );

    const connection = f.gw.core.link.connections.get(f.workerId)!;

    if (command.kind.case !== "startTurn") throw new Error("Expected StartTurn");
    const reply = connection.sendCommand(command.kind, 10_000, command.commandId);

    try {
      await f.gw.api.listDirectory({ workerId: f.workerId, path: f.dir });
      await f.gw.api.setThreadArchived({ threadId: thread.id, archived: true });
      await eventually(
        () => f.query<{ status: string }>("SELECT status FROM turns WHERE id=$1", [queued.id]),
        (rows) => rows[0]?.status === "cancelled",
      );
      await f.release("cancel-admission");
      expect((await reply).ok).toBe(true);
      expect(f.records().filter((r) => r.session === thread.providerThreadId && r.event === "turn")).toHaveLength(1);
      await f.finished(thread.id, held.id);
      await f.restartWorker();
      const restarted = f.gw.core.link.connections.get(f.workerId)!;
      expect((await restarted.sendCommand(command.kind, 10_000, crypto.randomUUID())).ok).toBe(true);
      expect(f.records().filter((r) => r.session === thread.providerThreadId && r.event === "turn")).toHaveLength(1);
      await f.gw.api.setThreadArchived({ threadId: thread.id, archived: false });
      const next = await f.send(thread.id, "new work after unarchive");
      expect((await f.finished(thread.id, next.id)).status).toBe("completed");
      expect(f.records().filter((r) => r.session === thread.providerThreadId && r.event === "turn")).toHaveLength(2);
    } finally {
      await f.release("cancel-admission");
      await Promise.allSettled([reply]);
    }
  }, 60_000);

  for (const harness of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) {
    test(`${Provider[harness]}: native→proxy→native keeps sessions; running turns keep old env and new work waits`, async () => {
      const name = Provider[harness]!.toLowerCase();
      await f.save(harness, `${name}-old`);
      const first = await f.thread(harness);
      const second = await f.thread(harness);
      const baseline = await f.send(first.id, "baseline");
      expect((await f.finished(first.id, baseline.id)).status).toBe("completed");

      const initial = f
        .records()
        .find((r) => r.harness === name && r.event === "turn" && r.session === first.providerThreadId)!;

      expect(initial.credentialMatches).toBe(true);

      if (harness === Provider.CODEX)
        writeFileSync(join(initial.home, "auth.json"), '{"tokens":{"access_token":"fixture-own-login"}}');
      const held = await f.send(first.id, `HOLD:${name}`);
      await eventually(
        async () => f.records(),
        (rs) =>
          rs.filter((r) => r.harness === name && r.event === "turn" && r.session === first.providerThreadId).length >=
          2,
      );

      const oldTurn = f
        .records()
        .filter((r) => r.harness === name && r.event === "turn")
        .at(-1)!;

      const changed = await f.save(harness, `${name}-proxy`, ProviderProfileKind.CLIPROXYAPI);
      expect(changed.id).toBe("native");
      expect(changed.builtIn).toBe(true);

      if (harness === Provider.CODEX) expect(changed.runtime?.ownLogin).toBe(true);
      const next = await f.send(second.id, "next after switch");
      // A later read-only command crosses the same link while the turn admission is waiting.
      await f.gw.api.listDirectory({ workerId: f.workerId, path: f.dir });
      expect(
        f
          .records()
          .filter((r) => r.harness === name && r.event === "turn")
          .at(-1)!.probe,
      ).toBe(`${name}-old`);
      expect(
        f.records().filter((r) => r.harness === name && r.event === "finish" && r.session === first.providerThreadId),
      ).toHaveLength(1);
      await f.release(name);
      expect((await f.finished(first.id, held.id)).status).toBe("completed");
      expect((await f.finished(second.id, next.id)).status).toBe("completed");

      const newTurn = f
        .records()
        .filter((r) => r.harness === name && r.event === "turn")
        .at(-1)!;

      expect(newTurn).toMatchObject({
        probe: `${name}-proxy`,
        proxy: true,
        credentialMatches: true,
        home: initial.home,
      });
      expect(newTurn.pid).not.toBe(oldTurn.pid);
      const resumed = await f.send(first.id, "resume existing session through proxy");
      expect((await f.finished(first.id, resumed.id)).status).toBe("completed");
      const resumeEvent = { codex: "thread/resume", claude: "resume", grok: "session/load" }[name];
      expect(
        f
          .records()
          .some(
            (r) =>
              r.harness === name &&
              r.event === resumeEvent &&
              r.session === first.providerThreadId &&
              r.probe === `${name}-proxy`,
          ),
      ).toBe(true);
      await f.save(harness, `${name}-back`);
      const back = await f.send(first.id, "back on device login");
      expect((await f.finished(first.id, back.id)).status).toBe("completed");

      const last = f
        .records()
        .filter((r) => r.harness === name && r.event === "turn")
        .at(-1)!;

      expect(last).toMatchObject({
        home: initial.home,
        session: first.providerThreadId,
        proxy: false,
        credentialMatches: true,
        probe: `${name}-back`,
      });

      if (harness === Provider.CODEX) {
        expect(last.provider).toBe("openai");
        expect(readFileSync(join(initial.home, "auth.json"), "utf8")).toContain("fixture-own-login");
        expect(
          f.records().filter((r) => r.harness === name && r.event === "spawn" && r.probe === `${name}-proxy`),
        ).toHaveLength(1);
      }
    }, 40_000);
  }

  test("Codex drains owned background work, restarts once, and leaves other instances untouched", async () => {
    await f.save(Provider.CODEX, "other", ProviderProfileKind.NATIVE, "other", true);
    const other = await f.thread(Provider.CODEX, "other");
    const old = f.records().find((r) => r.harness === "codex" && r.event === "spawn" && r.probe === "other")!;
    const first = await f.thread(Provider.CODEX);
    const started = await f.send(first.id, "BACKGROUND");
    expect((await f.finished(first.id, started.id)).status).toBe("completed");
    const second = await f.thread(Provider.CODEX);
    const heldOne = await f.send(first.id, "HOLD:drain-one");
    const heldTwo = await f.send(second.id, "HOLD:drain-two");
    await eventually(
      async () => f.records(),
      (rs) => rs.some((r) => r.event === "turn" && r.session === second.providerThreadId),
    );
    await f.save(Provider.CODEX, "superseded-config");
    await f.save(Provider.CODEX, "after-background");
    const next = await f.send(first.id, "wait for background drain");
    const separate = await f.send(other.id, "unrelated instance remains usable");
    expect((await f.finished(other.id, separate.id)).status).toBe("completed");
    expect(f.records().some((r) => r.event === "spawn" && r.probe === "after-background")).toBe(false);
    await f.release("drain-one");
    expect((await f.finished(first.id, heldOne.id)).status).toBe("completed");
    expect(f.records().some((r) => r.event === "spawn" && r.probe === "after-background")).toBe(false);
    await f.release("drain-two");
    expect((await f.finished(second.id, heldTwo.id)).status).toBe("completed");
    expect(f.records().some((r) => r.event === "spawn" && r.probe === "after-background")).toBe(false);
    await f.release("background");
    expect((await f.finished(first.id, next.id)).status).toBe("completed");
    expect(f.records().filter((r) => r.event === "spawn" && r.probe === "after-background")).toHaveLength(1);
    expect(f.records().filter((r) => r.event === "spawn" && r.probe === "superseded-config")).toHaveLength(0);
    expect(f.records().filter((r) => r.event === "spawn" && r.probe === "other")).toEqual([old]);
    await f.save(Provider.CODEX, "idle-restart");
    await eventually(
      async () => f.records(),
      (rs) => rs.some((r) => r.event === "spawn" && r.probe === "idle-restart"),
    );
    expect(f.records().filter((r) => r.event === "spawn" && r.probe === "idle-restart")).toHaveLength(1);
  }, 30_000);

  test("switches are owner scoped, revision checked and audited without secret values", async () => {
    const other = await f.gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("instance-other@example.test", "Other")),
    );

    const input = create(ui.SaveProviderInstanceRequestSchema, {
      harness: Provider.CODEX,
      id: "native",
      kind: ProviderProfileKind.NATIVE,
    });

    expect(
      await failure(f.gw.runtime.runPromise(InstanceStore.use((s) => s.save({ userId: other, request: input })))),
    ).toContain("not found");

    const current = (await f.gw.api.listProviderInstances({})).instances.find(
      (i) => i.harness === Provider.CODEX && i.id === "native",
    )!;

    expect(
      await failure(f.gw.api.saveProviderInstance({ ...input, expectedRevision: current.revision + 1n })),
    ).toContain("changed meanwhile");

    const audit = await f.query<{ details: object }>(
      "SELECT details FROM audit_log WHERE action='provider.connection_changed'",
    );

    expect(audit).toHaveLength(6);

    const publicData = JSON.stringify([
      toJson(ui.ListProviderInstancesResponseSchema, await f.gw.api.listProviderInstances({})),
      toJson(ui.GetOverviewResponseSchema, await f.gw.api.getOverview({})),
      audit,
      f.logs,
      f.records(),
    ]);

    expect(publicData.includes("fixture-proxy-key")).toBe(false);
    expect(publicData.includes("fixture-secret-")).toBe(false);
    expect(f.records().every((r) => r.credentialMatches)).toBe(true);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { AgentToolSessionDefaultsSchema, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { startInstanceFixture } from "./support/instance-fixture.ts";

describe.skipIf(!dockerAvailable)("first session creation after archive", () => {
  let gw: TestGateway;
  beforeAll(async () => {
    gw = await startTestGateway();
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
  }, 30_000);

  const query = <A extends object>(statement: string, params: readonly string[] = []) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.unsafe<A>(statement, params);
      }),
    );

  for (const kind of ["normal", "fork", "scratch"] as const) {
    test(`${kind}: unarchive does nothing; the first new message recreates the original placement and fork`, async () => {
      const added = await gw.addWorker(`Offline ${kind}`);
      const worker = await gw.connect(added.workerId, added.credential);
      await eventually(
        () => gw.api.getOverview({}),
        (o) => o.workers.find((w) => w.id === added.workerId)?.appliedVersion !== 0n,
      );

      const project =
        kind === "scratch"
          ? (await gw.api.getOverview({})).projects.find((p) => p.kind === "scratch")!
          : (await gw.api.createProject({ name: `Lazy creation ${kind}` })).project!;

      const workspace =
        kind === "scratch"
          ? project.workspaces.find((w) => w.workerId === added.workerId)!
          : (
              await gw.api.createWorkspace({
                projectId: project.id,
                workerId: added.workerId,
                rootPath: "/repo/lazy-create",
              })
            ).workspace!;

      let sourceId = "";
      let forkTurnId = "";

      if (kind === "fork") {
        const source = (
          await gw.api.createThread({
            projectId: project.id,
            workspaceId: workspace.id,
            provider: Provider.CODEX,
            initialMessage: "Source history",
          })
        ).thread!;

        await eventually(
          () => gw.api.getThread({ threadId: source.id }),
          (r) => r.thread?.status === "idle",
        );

        const turns = await eventually(
          () => gw.runtime.runPromise(GatewayStore.use((s) => s.turnsOf(source.id))),
          (rows) => rows[0]?.status === "completed",
        );

        sourceId = source.id;
        forkTurnId = turns[0]!.id;
      }

      worker.link.close();
      await eventually(
        async () => gw.core.online.has(added.workerId),
        (online) => !online,
      );

      const target = (
        await gw.api.createThread({
          projectId: project.id,
          workspaceId: workspace.id,
          provider: Provider.CODEX,
          title: `Never created ${kind}`,
          instructions: "Retain the original instructions",
          initialMessage: "Cancelled initial work",
          ...(sourceId && { parentThreadId: sourceId, fork: true, forkAtTurnId: forkTurnId }),
        })
      ).thread!;

      const original = (await gw.runtime.runPromise(GatewayStore.use((s) => s.pendingCommands(added.workerId)))).find(
        (c) => c.command.kind.case === "createThread" && c.command.kind.value.thread?.threadId === target.id,
      )!.command.kind;

      await gw.api.setThreadArchived({ threadId: target.id, archived: true });
      await gw.api.setThreadArchived({ threadId: target.id, archived: false });
      const reconnected = await gw.connect(added.workerId, added.credential);
      await eventually(
        () =>
          query<{ status: string }>(
            "SELECT status FROM worker_commands WHERE thread_id=$1::uuid AND kind='unloadThread'",
            [target.id],
          ),
        (rows) => rows[0]?.status === "completed",
      );
      expect(
        reconnected.commands.some((c) => c.case === "createThread" && c.value.thread?.threadId === target.id),
      ).toBe(false);
      expect(await query("SELECT provider_thread_id FROM threads WHERE id=$1::uuid", [target.id])).toEqual([
        { provider_thread_id: null },
      ]);

      const defaults = create(AgentToolSessionDefaultsSchema, {
        browser: { viewportWidth: 1366, viewportHeight: 768, colorScheme: "dark" },
      });

      await gw.api.updateUserSettings({
        expectedVersion: (await gw.api.getSettings({})).user!.version,
        agentToolDefaults: defaults,
      });

      const sent = (
        await gw.api.sendMessage({ threadId: target.id, text: "New user work", clientRequestId: Bun.randomUUIDv7() })
      ).turn!;

      await eventually(
        () => gw.runtime.runPromise(GatewayStore.use((s) => s.turnsOf(target.id))),
        (rows) => rows.find((r) => r.id === sent.id)?.status === "completed",
      );

      const recreated = reconnected.commands.find(
        (c) => c.case === "createThread" && c.value.thread?.threadId === target.id,
      );

      // Delivery refreshes tool defaults; the archived placement and fork must stay identical.
      if (original.case !== "createThread" || !original.value.thread) throw new Error("Missing original creation");
      original.value.thread.agentToolDefaults = defaults;
      expect(recreated).toEqual(original);
      expect(reconnected.inputs.get(target.id)).toEqual(["New user work"]);
      expect((await gw.api.getThread({ threadId: target.id })).thread?.cwd).toBe(target.cwd);
    });
  }
});

for (const provider of [Provider.CLAUDE, Provider.CODEX]) {
  test.skipIf(!dockerAvailable)(
    `${Provider[provider]} creates a never-started archived session only for a fresh message`,
    async () => {
      const f = await startInstanceFixture();

      try {
        await f.save(provider, "lazy-creation");
        const placement = await f.thread(provider);
        await f.disconnect();

        const target = (
          await f.gw.api.createThread({
            projectId: placement.projectId,
            workspaceId: placement.workspaceId,
            provider,
            initialMessage: "Cancelled initial work",
          })
        ).thread!;

        await f.gw.api.setThreadArchived({ threadId: target.id, archived: true });
        await f.gw.api.setThreadArchived({ threadId: target.id, archived: false });
        await f.reconnect();
        await eventually(
          () =>
            f.query<{ status: string }>(
              "SELECT status FROM worker_commands WHERE thread_id=$1::uuid AND kind='unloadThread'",
              [target.id],
            ),
          (rows) => rows[0]?.status === "completed",
        );
        expect(await f.query("SELECT provider_thread_id FROM threads WHERE id=$1::uuid", [target.id])).toEqual([
          { provider_thread_id: null },
        ]);
        const next = await f.send(target.id, "Create the session now");
        expect((await f.finished(target.id, next.id)).status).toBe("completed");
        expect(
          await f.query("SELECT status FROM turns WHERE thread_id=$1::uuid ORDER BY ordinal", [target.id]),
        ).toEqual([{ status: "cancelled" }, { status: "completed" }]);
      } finally {
        await f.close();
      }
    },
    90_000,
  );
}

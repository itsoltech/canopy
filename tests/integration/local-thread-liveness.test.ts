import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { SqlClient } from "effect/sql";
import { startTestGateway, eventually, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("local thread durable liveness", () => {
  let gateway: TestGateway;
  let thread: string;
  let project: string;

  beforeAll(async () => {
    gateway = await startTestGateway({ watchProbeMs: 100 });
    project = (await gateway.api.createProject({ name: "Local project" })).project!.id;

    const workspace = (
      await gateway.api.createWorkspace({ projectId: project, workerId: gateway.workerId, rootPath: "/repo/local" })
    ).workspace!.id;

    thread = (
      await gateway.api.createThread({
        projectId: project,
        workspaceId: workspace,
        provider: Provider.CODEX,
        title: "Before",
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;
  });
  afterAll(async () => {
    await gateway?.close();
  });

  test("an open local watch recovers a missed finish and metadata fan-out without reopening the UI", async () => {
    const abort = new AbortController();
    let snapshot: ui.ThreadSnapshot | undefined;
    let error: unknown;
    let syncing = 0;

    const read = (async () => {
      try {
        for await (const update of gateway.api.watchThread(
          { threadId: thread, incremental: true, pageSize: 24 },
          { signal: abort.signal },
        )) {
          if (update.syncing) syncing++;
          snapshot = applyThreadUpdate(snapshot, update);
        }
      } catch (cause) {
        if (!abort.signal.aborted) error = cause;
      }
    })();

    const publish = gateway.core.hub.publishThread.bind(gateway.core.hub);

    try {
      expect(
        await eventually(
          async () => snapshot?.thread?.title,
          (value) => value === "Before",
        ),
      ).toBe("Before");
      gateway.worker.holdTurns = true;

      const turn = (
        await gateway.api.sendMessage({ threadId: thread, text: "Hold the turn", clientRequestId: crypto.randomUUID() })
      ).turn!;

      expect(
        await eventually(
          async () => snapshot?.thread?.status,
          (value) => value === "running",
        ),
      ).toBe("running");
      gateway.core.hub.publishThread = () => {};

      await gateway.api.updateThread({ threadId: thread, title: "After missed fan-out" });
      gateway.worker.finish(thread, turn.id);
      expect(
        await eventually(
          async () =>
            snapshot?.thread?.status === "idle" &&
            snapshot?.thread?.title === "After missed fan-out" &&
            snapshot.turns.some((t) => t.id === turn.id && t.status === "completed"),
          Boolean,
          5000,
        ),
      ).toBe(true);
      expect(syncing).toBeGreaterThan(0);
      expect(error).toBeUndefined();
    } finally {
      gateway.core.hub.publishThread = publish;
      gateway.worker.holdTurns = false;
      abort.abort();
      await read;
    }
  }, 10_000);

  test("an open local watch recovers project secret changes when the Hub misses them", async () => {
    const name = "WATCH_TEST";
    const requestId = Bun.randomUUIDv7();
    const abort = new AbortController();
    const publish = gateway.core.hub.publishThread;

    const runSql = <A extends object>(text: string, ...params: string[]) =>
      gateway.runtime.runPromise(SqlClient.SqlClient.use((sql) => sql.unsafe<A>(text, params)));

    const revisions = () =>
      runSql<{ revision: string; entity_id: string | null }>(
        `SELECT revision::text,entity_id FROM computer_thread_changes
         WHERE owner_user_id=$1::uuid AND thread_id=$2::uuid AND entity_kind='thread_controls' ORDER BY revision`,
        gateway.userId,
        thread,
      );

    await gateway.api.putProjectSecret({ projectId: project, name, value: `synthetic-${requestId}` });
    gateway.core.hub.publishThread = (id, update) => {
      if (update.change.case !== "secret") publish.call(gateway.core.hub, id, update);
    };

    gateway.worker.holdTurns = true;
    let turnId: string | undefined;
    let snapshot: ui.ThreadSnapshot | undefined;
    let failure: unknown;

    const read = (async () => {
      try {
        for await (const update of gateway.api.watchThread(
          { threadId: thread, incremental: true },
          { signal: abort.signal },
        ))
          snapshot = applyThreadUpdate(snapshot, update);
      } catch (error) {
        if (!abort.signal.aborted) failure = error;
      }
    })();

    const waitForSecret = (status: string) =>
      eventually(
        async () => snapshot?.secrets.find((entry) => entry.requestId === requestId),
        (entry) => entry?.status === status,
        2000,
      );

    try {
      expect(
        await eventually(
          async () => snapshot?.thread?.id,
          (id) => id === thread,
          2000,
        ),
      ).toBe(thread);
      const { turn } = await gateway.api.sendMessage({ threadId: thread, text: "Hold for the lease watch" });
      turnId = turn!.id;
      expect(
        await eventually(
          async () => snapshot?.turns.find((entry) => entry.id === turnId)?.status,
          (status) => status === "running",
          2000,
        ),
      ).toBe("running");
      await runSql(
        `INSERT INTO project_secret_leases(id,owner_user_id,project_id,thread_id,turn_id,worker_id,worker_epoch,name)
         SELECT $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,c.worker_id,c.epoch,$6
         FROM worker_connections c WHERE c.worker_id=$7::uuid`,
        requestId,
        gateway.userId,
        project,
        thread,
        turnId,
        name,
        gateway.workerId,
      );
      expect(await waitForSecret("saved")).toMatchObject({ projectSecret: name, status: "saved" });
      const beforeAck = await revisions();
      expect(beforeAck).toEqual([{ revision: expect.any(String), entity_id: null }]);

      await runSql(
        `UPDATE project_secret_leases SET last_delivery_at=now(),applied_revision=revision,file_path='/private/synthetic'
         WHERE id=$1::uuid`,
        requestId,
      );
      expect(await revisions()).toEqual(beforeAck);

      await gateway.api.deleteProjectSecret({ projectId: project, name });
      expect(await waitForSecret("revoked")).toMatchObject({ projectSecret: name, status: "revoked" });
      expect(await revisions()).toHaveLength(2);
      expect(failure).toBeUndefined();
    } finally {
      abort.abort();
      gateway.core.hub.publishThread = publish;
      gateway.worker.holdTurns = false;

      if (turnId) gateway.worker.finish(thread, turnId);
      await read;
    }
  }, 10_000);
});

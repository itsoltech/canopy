import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { startTestGateway, eventually, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("local thread durable liveness", () => {
  let gateway: TestGateway;
  let thread: string;

  beforeAll(async () => {
    gateway = await startTestGateway({ watchProbeMs: 100 });
    const project = (await gateway.api.createProject({ name: "Local project" })).project!.id;

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
});

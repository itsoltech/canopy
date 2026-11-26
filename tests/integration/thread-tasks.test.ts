/**
 * The thread's task list in ui.Thread (docs/agent-bus.md, "Lista zadań"): worker checklist items -> ingest ->
 * thread_items -> the thread select (partial index thread_items_task_lists) -> Thread.tasks in the list.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import { ItemSchema, ItemStatus, PermissionMode, Provider, TurnOrigin, TurnOutcome, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

let gw: TestGateway;
let api: Client<typeof ui.GatewayService>;

type Content = NonNullable<MessageInitShape<typeof ItemSchema>["content"]>;

describe.skipIf(!dockerAvailable)("thread task list (gateway)", () => {
  let projectId = "";
  let workspaceId = "";

  beforeAll(async () => {
    gw = await startTestGateway();
    api = gw.api;
    projectId = (await api.createProject({ name: "Tasks" })).project!.id;
    workspaceId = (await api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/a" })).workspace!.id;
    await eventually(
      () => api.getOverview({}),
      (o) => o.workers.every((w) => w.appliedVersion === 2n),
    );
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  /** One turn whose worker emits these completed items, in order. */
  const turn = async (threadId: string, request: string, items: readonly Content[]) => {
    const worker = gw.worker;
    const done = Promise.withResolvers<void>();
    worker.handlers.set("startTurn", (value, reply) => {
      const { turnId } = value as { turnId: string };
      reply(true);
      worker.emit(threadId, turnId, { case: "turnStarted", value: { origin: TurnOrigin.COMMAND } });

      for (const [index, content] of items.entries())
        worker.emit(threadId, turnId, {
          case: "itemCompleted",
          value: { item: { itemId: `${request}-${index}`, status: ItemStatus.COMPLETED, content } },
        });
      worker.emit(threadId, turnId, { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED } });
      done.resolve();
    });
    await api.sendMessage({ threadId, text: request, clientRequestId: request });
    await done.promise;
    worker.handlers.delete("startTurn");
  };

  const updateTasks = (tasks: { title: string; status: string }[], isError = false): Content => ({
    case: "agentBusCall",
    value: { toolName: "update_tasks", argumentsJson: JSON.stringify({ tasks }), resultJson: "{}", isError },
  });

  test("the latest list sets Thread.tasks; refused calls and step-less plans leave it; a later turn retires it", async () => {
    const threadId = (
      await api.createThread({
        projectId,
        workspaceId,
        title: "t",
        provider: Provider.CODEX,
        permissionMode: PermissionMode.ASK,
      })
    ).thread!.id;

    await eventually(
      () => api.getThread({ threadId }),
      (r) => r.thread?.status === "idle",
    );

    await turn(threadId, "plan", [
      // A harness plan with steps, then the platform tool: the later one wins.
      {
        case: "plan",
        value: { text: "", steps: [{ text: "Old step", status: "pending" }] },
      },
      updateTasks([
        { title: "Add the migration", status: "completed" },
        { title: "Wire the sidebar", status: "in_progress" },
        { title: "Update the docs", status: "pending" },
      ]),
      // Neither a refused call nor a proposed plan without steps replaces it.
      updateTasks([{ title: "Refused", status: "pending" }], true),
      { case: "plan", value: { text: "A proposal", steps: [] } },
    ]);

    const listed = await eventually(
      () => api.getThread({ threadId }),
      (r) => r.thread?.status === "idle" && r.thread.tasks !== undefined,
    );

    expect(listed.thread?.tasks).toMatchObject({ completed: 1, total: 3, current: "Wire the sidebar" });
    // The sidebar's list reads it from the same select.
    const sidebar = await api.listThreads({ projectId, sidebarOnly: true });
    expect(sidebar.threads.find((t) => t.id === threadId)?.tasks?.current).toBe("Wire the sidebar");

    // A later turn that ends without touching the unfinished list retires it.
    await turn(threadId, "other", [{ case: "agentMessage", value: { text: "Something else." } }]);

    const retired = await eventually(
      () => api.getThread({ threadId }),
      (r) => r.thread?.status === "idle" && r.thread.lastTurnStatus === "completed" && r.thread.tasks === undefined,
    );

    expect(retired.thread?.tasks).toBeUndefined();
  }, 60_000);
});

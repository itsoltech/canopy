/**
 * Gateway end to end on PostgreSQL: BFF client (gRPC, service token) -> GatewayService -> core ->
 * outbox -> worker link (gRPC, same server) -> scripted worker -> events -> ingest -> live updates.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Code, ConnectError, createClient, type Client } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { InteractionKind, PermissionMode, Provider, ui } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { answers, failure, startTestGateway, watchUntil, type ScriptedWorker, type TestGateway } from "./support/gateway.ts";

let gw: TestGateway;
let api: Client<typeof ui.GatewayService>;
let worker: ScriptedWorker;
let grpcUrl = "";

describe.skipIf(!dockerAvailable)("gateway end to end (UI API -> worker -> UI)", () => {
  let projectId = "";
  let workspaceId = "";

  beforeAll(async () => {
    gw = await startTestGateway();
    ({ api, worker, grpcUrl } = gw);
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  test("overview: the worker is online and has applied its configuration", async () => {
    let overview = await api.getOverview({});
    for (let i = 0; i < 50 && overview.workers[0]?.appliedVersion !== 1n; i++) {
      await Bun.sleep(50);
      overview = await api.getOverview({});
    }
    expect(overview.workers.map((w) => [w.name, w.online, w.configVersion, w.appliedVersion, w.allowedRoots])).toEqual([["laptop", true, 1n, 1n, ["/repo"]]]);
  });

  test("project, workspace and directory browsing through the worker", async () => {
    const workerId = (await api.getOverview({})).workers[0]!.id;
    const listing = await api.listDirectory({ workerId, path: "/repo" });
    expect(listing.entries.map((e) => e.name)).toEqual(["repo-a"]);
    projectId = (await api.createProject({ name: "Open Agents" })).project!.id;
    workspaceId = (await api.createWorkspace({ projectId, workerId, rootPath: "/repo/repo-a", label: "laptop" })).workspace!.id;
    const project = (await api.getOverview({})).projects.find((p) => p.id === projectId);
    expect(project?.workspaces.map((w) => w.rootPath)).toEqual(["/repo/repo-a"]);
  });

  test("thread with a first message: created on the worker, turn runs, answer streams to the UI", async () => {
    const thread = (
      await api.createThread({
        projectId,
        workspaceId,
        title: "Hello",
        provider: Provider.CODEX,
        permissionMode: PermissionMode.ASK,
        initialMessage: "hello",
        clientRequestId: "req-1",
      })
    ).thread!;
    expect(thread.status).toBe("creating");
    const updates = await watchUntil(api, thread.id, (u) => answers(u).includes("Echo: hello") && u.some((x) => x.change.case === "thread" && x.change.value.status === "idle"));
    expect(updates[0]?.change.case).toBe("snapshot");
    expect(answers(updates)).toContain("Echo: hello");

    // A second message queues and runs after the first one.
    await api.sendMessage({ threadId: thread.id, text: "second", clientRequestId: "req-2" });
    const again = await watchUntil(api, 
      thread.id,
      (u) => answers(u).includes("Echo: second") && u.some((x) => x.change.case === "turn" && x.change.value.inputText === "second" && x.change.value.status === "completed"),
    );
    expect(answers(again)).toEqual(expect.arrayContaining(["Echo: hello", "Echo: second"]));
    const snapshot = again[0]?.change.case === "snapshot" ? again[0].change.value : undefined;
    expect(snapshot?.thread?.status).toBeDefined();

    // Retried send (same client request id) does not create another turn.
    const retry = await api.sendMessage({ threadId: thread.id, text: "second", clientRequestId: "req-2" });
    const final = await watchUntil(api, thread.id, (u) => u.length >= 1);
    const turns = final[0]?.change.case === "snapshot" ? final[0].change.value.turns : [];
    expect(turns.map((t) => [t.inputText, t.status])).toEqual([
      ["hello", "completed"],
      ["second", "completed"],
    ]);
    expect(retry.turn?.id).toBe(turns[1]?.id);
  });

  test("interaction: worker asks, UI sees it live and answers, the worker gets the decision", async () => {
    const thread = (await api.createThread({ projectId, workspaceId, title: "Ask", provider: Provider.CODEX, clientRequestId: "req-3" })).thread!;
    const requestId = Bun.randomUUIDv7();
    const updates = await watchUntil(api, 
      thread.id,
      (u) => u.some((x) => x.change.case === "interaction" && x.change.value.status === "allowed"),
      (update) => {
        if (update.change.case === "snapshot") {
          worker.link.send({
            case: "interactionRequest",
            value: { requestId, threadId: thread.id, kind: InteractionKind.PERMISSION, toolName: "shell", requestJson: '{"command":"rm -rf build"}' },
          });
        }
        if (update.change.case === "interaction" && update.change.value.status === "pending") {
          void api.answerInteraction({ requestId, allow: true });
        }
      },
    );
    const statuses = updates.flatMap((u) => (u.change.case === "interaction" ? [u.change.value.status] : []));
    expect(statuses).toEqual(["pending", "allowed"]);
    for (let i = 0; i < 50 && worker.interactionAnswers.length === 0; i++) await Bun.sleep(20);
    expect(worker.interactionAnswers).toEqual([{ requestId, allow: true }]);
    // Answering twice is refused.
    expect(await failure(api.answerInteraction({ requestId, allow: false }))).toContain("already allowed");
  });

  test("a worker refusing to create the thread makes it failed with the reason", async () => {
    const workerId = (await api.getOverview({})).workers[0]!.id;
    // Inside the configured root, but refused by the worker (as for a symlink leading outside).
    const bad = (await api.createWorkspace({ projectId, workerId, rootPath: "/repo/forbidden", label: "x" })).workspace!.id;
    const thread = (await api.createThread({ projectId, workspaceId: bad, title: "Nope", provider: Provider.CODEX })).thread!;
    const updates = await watchUntil(api, thread.id, (u) => u.some((x) => x.change.case === "thread" && x.change.value.status === "failed"));
    const failed = updates.flatMap((u) => (u.change.case === "thread" ? [u.change.value] : [])).find((t) => t.status === "failed");
    expect(failed?.statusDetail).toContain("CWD_NOT_ALLOWED");
  });

  test("only the BFF with the service token may call GatewayService", async () => {
    for (const token of [undefined, "wrong-token"]) {
      const anonymous = createClient(
        ui.GatewayService,
        createGrpcTransport({
          baseUrl: grpcUrl,
          interceptors: token ? [(next) => (request) => (request.header.set("authorization", `Bearer ${token}`), next(request))] : [],
        }),
      );
      const error = await anonymous.getOverview({}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConnectError);
      expect((error as ConnectError).code).toBe(Code.Unauthenticated);
    }
  });

  test("a workspace must lie within the worker's allowed directories", async () => {
    const workerId = (await api.getOverview({})).workers[0]!.id;
    for (const rootPath of ["/etc", "/repo-other", "/repo/../etc"]) {
      const error = await api.createWorkspace({ projectId, workerId, rootPath, label: "x" }).catch((e: unknown) => e);
      expect((error as ConnectError).code).toBe(Code.InvalidArgument);
    }
  });

  test("a project spans workers on different systems; a thread waits for its worker to connect", async () => {
    const laptopId = (await api.getOverview({})).workers[0]!.id;
    const { workerId: winId, credential } = await gw.addWorker("win-box", ["C:\\code"]);

    // Windows path rules on a Linux gateway: normalized, case-insensitive duplicates refused.
    const winWorkspace = (await api.createWorkspace({ projectId, workerId: winId, rootPath: "C:/code/app/", label: "win" })).workspace!;
    expect(winWorkspace.rootPath).toBe("C:\\code\\app");
    expect(await failure(api.createWorkspace({ projectId, workerId: winId, rootPath: "c:\\CODE\\App", label: "x" }))).toContain("already a workspace");
    expect(await failure(api.createWorkspace({ projectId, workerId: winId, rootPath: "C:\\other", label: "x" }))).toContain("outside the worker's allowed");
    expect(await failure(api.createWorkspace({ projectId, workerId: winId, rootPath: "/repo/repo-a", label: "x" }))).toContain("must be absolute");
    // The same project also lives on the laptop: one workspace per (worker, directory).
    const project = (await api.getOverview({})).projects.find((p) => p.id === projectId)!;
    expect(new Set(project.workspaces.map((w) => w.workerId))).toEqual(new Set([laptopId, winId]));

    // The Windows worker is offline: the thread is accepted and its command waits in the outbox.
    const thread = (
      await api.createThread({ projectId, workspaceId: winWorkspace.id, cwd: "c:/code/app/src", title: "On Windows", provider: Provider.CODEX, initialMessage: "ping" })
    ).thread!;
    expect([thread.workerId, thread.cwd, thread.status]).toEqual([winId, "c:\\code\\app\\src", "creating"]);
    expect(worker.created.some((c) => c.threadId === thread.id)).toBe(false);

    const win = await gw.connect(winId, credential, "win32");
    const updates = await watchUntil(api, thread.id, (u) => answers(u).includes("Echo: ping"));
    expect(answers(updates)).toContain("Echo: ping");
    expect(win.created.map((c) => [c.threadId, c.cwd])).toEqual([[thread.id, "c:\\code\\app\\src"]]);
    expect(worker.created.some((c) => c.threadId === thread.id)).toBe(false);
    expect((await api.getOverview({})).workers.find((w) => w.id === winId)?.os).toBe("win32");

    // A thread never starts outside its workspace, and a side thread stays in its parent's workspace.
    expect(await failure(api.createThread({ projectId, workspaceId: winWorkspace.id, cwd: "C:\\code", title: "x", provider: Provider.CODEX }))).toContain("outside the workspace");
    expect(await failure(api.createThread({ projectId, workspaceId, parentThreadId: thread.id, title: "x", provider: Provider.CODEX }))).toContain("parent's workspace");
  });

  test("errors keep their meaning across the API", async () => {
    expect(await failure(api.createProject({ name: "  " }))).toContain("project name is required");
    expect(await failure(api.sendMessage({ threadId: Bun.randomUUIDv7(), text: "x" }))).not.toBe("");
  });
});

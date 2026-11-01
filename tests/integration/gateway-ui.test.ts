/**
 * Gateway end to end on PostgreSQL: BFF client (gRPC, service token) -> GatewayService -> core ->
 * outbox -> worker link (gRPC, same server) -> scripted worker -> events -> ingest -> live updates.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { InteractionKind, ItemStatus, PermissionMode, Provider, ThreadEventSchema, TurnOrigin, TurnOutcome, ui } from "@open-agents/contracts";
import { migrate } from "@open-agents/db";
import { dockerAvailable, startPostgres, type TestPostgres } from "@open-agents/db/testing";
import { serviceTokenAuth, uiRoutes } from "@open-agents/gateway/api";
import { GatewayCore } from "@open-agents/gateway/core";
import { GatewayStore, Ingest } from "@open-agents/gateway/store";
import { startGrpcServer } from "@open-agents/transport";
import { openGatewayLink, type GatewayLink } from "@open-agents/worker/gateway-link";
import { Layer, ManagedRuntime } from "effect";
import type { SqlClient } from "effect/sql";

let pg: TestPostgres;
let runtime: ManagedRuntime.ManagedRuntime<GatewayStore | Ingest | SqlClient.SqlClient, unknown>;
let core: GatewayCore;
let closeAll: () => Promise<void>;
let api: Client<typeof ui.GatewayService>;
let worker: ScriptedWorker;
const otherWorkers: ScriptedWorker[] = [];
let userId = "";
let grpcUrl = "";
const SERVICE_TOKEN = "t".repeat(48);

/** Plays a worker: answers commands and emits the events a real provider would. */
class ScriptedWorker {
  readonly interactionAnswers: { requestId: string; allow: boolean }[] = [];
  /** Threads this worker was asked to create, with their cwd. */
  readonly created: { threadId: string; cwd: string }[] = [];
  readonly #seq = new Map<string, bigint>();
  constructor(readonly link: GatewayLink) {
    void this.#loop();
  }

  emit(threadId: string, turnId: string, body: NonNullable<MessageInitShape<typeof ThreadEventSchema>["body"]>): void {
    const journalSeq = (this.#seq.get(threadId) ?? 0n) + 1n;
    this.#seq.set(threadId, journalSeq);
    this.link.send({ case: "threadEvent", value: create(ThreadEventSchema, { threadId, turnId, journalSeq, eventId: Bun.randomUUIDv7(), body, rawJson: "{}" }) });
  }

  async #loop(): Promise<void> {
    for await (const message of this.link.messages) {
      const payload = message.payload;
      if (payload.case === "config") this.link.send({ case: "configApplied", value: { version: payload.value.version, applied: true } });
      if (payload.case === "interactionResponse") this.interactionAnswers.push({ requestId: payload.value.requestId, allow: payload.value.allow });
      if (payload.case !== "command") continue;
      const { commandId, kind } = payload.value;
      const reply = (ok: boolean, extra: Record<string, unknown> = {}) => this.link.send({ case: "commandResult", value: { commandId, ok, ...extra } });
      switch (kind.case) {
        case "listDirectory":
          reply(true, { entries: [{ name: "repo-a", isDir: true, isGitRepo: true }] });
          break;
        case "createThread": {
          const spec = kind.value.thread!;
          if (spec.cwd.includes("forbidden")) {
            reply(false, { errorCode: "CWD_NOT_ALLOWED", errorMessage: `${spec.cwd} is outside the allowed roots` });
            break;
          }
          this.created.push({ threadId: spec.threadId, cwd: spec.cwd });
          reply(true);
          this.emit(spec.threadId, "", { case: "threadReady", value: { providerThreadId: `codex-${spec.threadId.slice(-4)}` } });
          break;
        }
        case "startTurn": {
          const { thread, turnId, input } = kind.value;
          reply(true);
          this.emit(thread!.threadId, turnId, { case: "turnStarted", value: { providerTurnRef: `ct-${turnId.slice(-4)}`, origin: TurnOrigin.COMMAND } });
          this.emit(thread!.threadId, turnId, {
            case: "itemCompleted",
            value: { item: { itemId: `msg-${turnId}`, status: ItemStatus.COMPLETED, content: { case: "agentMessage", value: { text: `Echo: ${input!.text}`, phase: "final_answer" } } } },
          });
          this.emit(thread!.threadId, turnId, { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED, providerTurnRef: `ct-${turnId.slice(-4)}` } });
          break;
        }
        default:
          reply(true);
      }
    }
  }
}

/** Collects WatchThread updates until the predicate holds. */
async function watchUntil(threadId: string, done: (updates: ui.ThreadUpdate[]) => boolean, onUpdate?: (u: ui.ThreadUpdate) => void) {
  const controller = new AbortController();
  const updates: ui.ThreadUpdate[] = [];
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    for await (const update of api.watchThread({ threadId }, { signal: controller.signal })) {
      updates.push(update);
      onUpdate?.(update);
      if (done(updates)) break;
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  return updates;
}

/** Message of the error a call fails with ("" if it succeeds). `await expect(p).rejects` hangs on these calls in Bun 1.4. */
const failure = (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => "",
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );

const answers = (updates: ui.ThreadUpdate[]) => [
  ...updates.flatMap((u) => (u.change.case === "snapshot" ? u.change.value.items.map((i) => i.item) : [])),
  ...updates.flatMap((u) => (u.change.case === "event" && u.change.value.event?.body.case === "itemCompleted" ? [u.change.value.event.body.value.item] : [])),
].flatMap((item) => (item?.content.case === "agentMessage" ? [item.content.value.text] : []));

describe.skipIf(!dockerAvailable)("gateway end to end (UI API -> worker -> UI)", () => {
  let projectId = "";
  let workspaceId = "";

  beforeAll(async () => {
    pg = await startPostgres();
    runtime = ManagedRuntime.make(Layer.mergeAll(GatewayStore.layer(randomBytes(32)), Ingest.layer).pipe(Layer.provideMerge(pg.layer)));
    await runtime.runPromise(migrate);
    userId = await runtime.runPromise(GatewayStore.use((s) => s.ensureUser("dev@localhost", "Dev")));
    const { workerId, credential } = await runtime.runPromise(GatewayStore.use((s) => s.addWorker({ name: "laptop", ownerUserId: userId })));
    await runtime.runPromise(GatewayStore.use((s) => s.setWorkerConfig(workerId, { allowedRoots: ["/repo"], codex: { enabled: true } }, userId)));

    core = new GatewayCore({ runtime, instanceId: "test", userId });
    const grpc = await startGrpcServer({
      routes: (router) => {
        core.link.routes(router);
        uiRoutes(core)(router);
      },
      interceptors: [serviceTokenAuth(SERVICE_TOKEN)],
    });
    grpcUrl = grpc.url;
    api = createClient(
      ui.GatewayService,
      createGrpcTransport({
        baseUrl: grpc.url,
        interceptors: [(next) => (request) => (request.header.set("authorization", `Bearer ${SERVICE_TOKEN}`), next(request))],
      }),
    );
    worker = new ScriptedWorker(await openGatewayLink({ baseUrl: grpc.url, credential, hello: { workerId, journalId: "journal-1" } }));
    closeAll = async () => {
      worker.link.close();
      for (const other of otherWorkers) other.link.close();
      await core.link.shutdown();
      await grpc.close();
    };
  }, 60_000);

  afterAll(async () => {
    await closeAll?.();
    await runtime?.dispose();
    pg?.stop();
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
    const updates = await watchUntil(thread.id, (u) => answers(u).includes("Echo: hello") && u.some((x) => x.change.case === "thread" && x.change.value.status === "idle"));
    expect(updates[0]?.change.case).toBe("snapshot");
    expect(answers(updates)).toContain("Echo: hello");

    // A second message queues and runs after the first one.
    await api.sendMessage({ threadId: thread.id, text: "second", clientRequestId: "req-2" });
    const again = await watchUntil(
      thread.id,
      (u) => answers(u).includes("Echo: second") && u.some((x) => x.change.case === "turn" && x.change.value.inputText === "second" && x.change.value.status === "completed"),
    );
    expect(answers(again)).toEqual(expect.arrayContaining(["Echo: hello", "Echo: second"]));
    const snapshot = again[0]?.change.case === "snapshot" ? again[0].change.value : undefined;
    expect(snapshot?.thread?.status).toBeDefined();

    // Retried send (same client request id) does not create another turn.
    const retry = await api.sendMessage({ threadId: thread.id, text: "second", clientRequestId: "req-2" });
    const final = await watchUntil(thread.id, (u) => u.length >= 1);
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
    const updates = await watchUntil(
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
    const updates = await watchUntil(thread.id, (u) => u.some((x) => x.change.case === "thread" && x.change.value.status === "failed"));
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
    const { workerId: winId, credential } = await runtime.runPromise(GatewayStore.use((s) => s.addWorker({ name: "win-box", ownerUserId: userId })));
    await runtime.runPromise(GatewayStore.use((s) => s.setWorkerConfig(winId, { allowedRoots: ["C:\\code"], codex: { enabled: true } }, userId)));

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

    const win = new ScriptedWorker(
      await openGatewayLink({ baseUrl: grpcUrl, credential, hello: { workerId: winId, journalId: "journal-win", host: { os: "win32" } } }),
    );
    otherWorkers.push(win);
    const updates = await watchUntil(thread.id, (u) => answers(u).includes("Echo: ping"));
    expect(answers(updates)).toContain("Echo: ping");
    expect(win.created).toEqual([{ threadId: thread.id, cwd: "c:\\code\\app\\src" }]);
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

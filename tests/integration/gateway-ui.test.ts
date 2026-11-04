/**
 * Gateway end to end on PostgreSQL: BFF client (gRPC, service token) -> GatewayService -> core ->
 * outbox -> worker link (gRPC, same server) -> scripted worker -> events -> ingest -> live updates.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Code, ConnectError, createClient, type Client } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { create } from "@bufbuild/protobuf";
import { InteractionKind, NoticeLevel, PermissionMode, Provider, TurnOrigin, TurnOutcome, ui } from "@canopy/contracts";
import { GatewayStore } from "@canopy/gateway/store";
import { dockerAvailable } from "@canopy/db/testing";
import {
  answers,
  eventually,
  failure,
  startTestGateway,
  watchUntil,
  type ScriptedWorker,
  type TestGateway,
} from "./support/gateway.ts";

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

    for (let i = 0; i < 50 && overview.workers[0]?.appliedVersion !== 2n; i++) {
      await Bun.sleep(50);
      overview = await api.getOverview({});
    }

    expect(overview.workers.map((w) => [w.name, w.online, w.configVersion, w.appliedVersion, w.allowedRoots])).toEqual([
      ["laptop", true, 2n, 2n, []],
    ]);
  });

  test("project, workspace and directory browsing through the worker", async () => {
    const workerId = (await api.getOverview({})).workers[0]!.id;
    const listing = await api.listDirectory({ workerId, path: "/repo" });
    expect(listing.entries.map((e) => e.name)).toEqual(["repo-a"]);
    projectId = (await api.createProject({ name: "Canopy" })).project!.id;
    workspaceId = (await api.createWorkspace({ projectId, workerId, rootPath: "/repo/repo-a", label: "laptop" }))
      .workspace!.id;
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

    const updates = await watchUntil(
      api,
      thread.id,
      (u) =>
        answers(u).includes("Echo: hello") &&
        u.some((x) => x.change.case === "thread" && x.change.value.status === "idle"),
    );

    expect(updates[0]?.change.case).toBe("snapshot");
    expect(answers(updates)).toContain("Echo: hello");

    // A second message queues and runs after the first one.
    await api.sendMessage({ threadId: thread.id, text: "second", clientRequestId: "req-2" });

    const again = await watchUntil(
      api,
      thread.id,
      (u) =>
        answers(u).includes("Echo: second") &&
        u.some(
          (x) =>
            x.change.case === "turn" && x.change.value.inputText === "second" && x.change.value.status === "completed",
        ),
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
    const thread = (
      await api.createThread({
        projectId,
        workspaceId,
        title: "Ask",
        provider: Provider.CODEX,
        clientRequestId: "req-3",
      })
    ).thread!;

    const requestId = Bun.randomUUIDv7();

    const updates = await watchUntil(
      api,
      thread.id,
      (u) => u.some((x) => x.change.case === "interaction" && x.change.value.status === "allowed"),
      (update) => {
        if (update.change.case === "snapshot") {
          worker.link.send({
            case: "interactionRequest",
            value: {
              requestId,
              threadId: thread.id,
              kind: InteractionKind.PERMISSION,
              toolName: "shell",
              requestJson: '{"command":"rm -rf build"}',
            },
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

    // The directory disappeared between adding the workspace and starting the thread.
    const bad = (await api.createWorkspace({ projectId, workerId, rootPath: "/repo/forbidden", label: "x" })).workspace!
      .id;

    const thread = (await api.createThread({ projectId, workspaceId: bad, title: "Nope", provider: Provider.CODEX }))
      .thread!;

    const updates = await watchUntil(api, thread.id, (u) =>
      u.some((x) => x.change.case === "thread" && x.change.value.status === "failed"),
    );

    const failed = updates
      .flatMap((u) => (u.change.case === "thread" ? [u.change.value] : []))
      .find((t) => t.status === "failed");

    expect(failed?.statusDetail).toContain("CWD_NOT_FOUND");
  });

  test("only the BFF with the service token may call GatewayService", async () => {
    for (const token of [undefined, "wrong-token"]) {
      const anonymous = createClient(
        ui.GatewayService,
        createGrpcTransport({
          baseUrl: grpcUrl,
          interceptors: token
            ? [(next) => (request) => (request.header.set("authorization", `Bearer ${token}`), next(request))]
            : [],
        }),
      );

      const error = await anonymous.getOverview({}).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ConnectError);
      expect((error as ConnectError).code).toBe(Code.Unauthenticated);
    }
  });

  test("workspaces accept any absolute directory, while relative and missing paths fail", async () => {
    const workerId = (await api.getOverview({})).workers[0]!.id;

    for (const rootPath of ["/etc", "/repo-other"]) {
      expect((await api.createWorkspace({ projectId, workerId, rootPath })).workspace?.rootPath).toBe(rootPath);
    }

    for (const rootPath of ["relative", "/missing-workspace"]) {
      const error = await api
        .createWorkspace({ projectId, workerId, rootPath, label: "x" })
        .catch((cause: unknown) => cause);

      expect((error as ConnectError).code).toBe(Code.InvalidArgument);
    }
  });

  test("a project spans workers on different systems; a thread waits for its worker to connect", async () => {
    const laptopId = (await api.getOverview({})).workers[0]!.id;
    const { workerId: winId, credential } = await gw.addWorker("win-box", ["C:\\code"]);
    const initialWin = await gw.connect(winId, credential, "win32");
    await eventually(
      () => api.getOverview({}),
      (o) => o.workers.some((w) => w.id === winId && w.online && w.os === "win32"),
    );

    // Windows path rules on a Linux gateway: normalized, case-insensitive duplicates refused.
    const winWorkspace = (
      await api.createWorkspace({ projectId, workerId: winId, rootPath: "C:/code/app/", label: "win" })
    ).workspace!;

    expect(winWorkspace.rootPath).toBe("C:\\code\\app");
    expect(
      await failure(api.createWorkspace({ projectId, workerId: winId, rootPath: "c:\\CODE\\App", label: "x" })),
    ).toContain("already a workspace");
    expect(
      (await api.createWorkspace({ projectId, workerId: winId, rootPath: "C:\\other", label: "x" })).workspace
        ?.rootPath,
    ).toBe("C:\\other");
    expect(
      await failure(api.createWorkspace({ projectId, workerId: winId, rootPath: "/repo/repo-a", label: "x" })),
    ).toContain("must be absolute");
    // The same project also lives on the laptop: one workspace per (worker, directory).
    const project = (await api.getOverview({})).projects.find((p) => p.id === projectId)!;
    expect(new Set(project.workspaces.map((w) => w.workerId))).toEqual(new Set([laptopId, winId]));
    initialWin.link.close();
    await eventually(
      () => api.getOverview({}),
      (o) => o.workers.some((w) => w.id === winId && !w.online),
    );

    // The Windows worker is offline: the thread is accepted and its command waits in the outbox.
    const thread = (
      await api.createThread({
        projectId,
        workspaceId: winWorkspace.id,
        cwd: "c:/code/app/src",
        title: "On Windows",
        provider: Provider.CODEX,
        initialMessage: "ping",
      })
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
    expect(
      await failure(
        api.createThread({
          projectId,
          workspaceId: winWorkspace.id,
          cwd: "C:\\code",
          title: "x",
          provider: Provider.CODEX,
        }),
      ),
    ).toContain("outside the workspace");
    expect(
      await failure(
        api.createThread({ projectId, workspaceId, parentThreadId: thread.id, title: "x", provider: Provider.CODEX }),
      ),
    ).toContain("parent's workspace");
  });

  test("a project lives on the workers it has a workspace on: another directory, removed from a worker", async () => {
    const workerId = (await api.getOverview({})).workers[0]!.id;
    const moving = (await api.createProject({ name: "Moving" })).project!.id;

    const ws = (await api.createWorkspace({ projectId: moving, workerId, rootPath: "/repo/repo-a", label: "laptop" }))
      .workspace!;

    const thread = (
      await api.createThread({
        projectId: moving,
        workspaceId: ws.id,
        title: "Before",
        provider: Provider.CODEX,
        initialMessage: "one",
      })
    ).thread!;

    await watchUntil(
      api,
      thread.id,
      (u) =>
        answers(u).includes("Echo: one") &&
        u.some((x) => x.change.case === "thread" && x.change.value.status === "idle"),
    );

    // Another directory on the same worker: same rules as a new workspace; the thread keeps its own directory.
    expect(await failure(api.updateWorkspace({ workspaceId: ws.id, rootPath: "/missing-directory" }))).toContain(
      "does not exist",
    );
    expect((await api.updateWorkspace({ workspaceId: ws.id, rootPath: "/anywhere-else" })).workspace?.rootPath).toBe(
      "/anywhere-else",
    );
    const moved = (await api.updateWorkspace({ workspaceId: ws.id, rootPath: "/repo/" })).workspace!;
    expect([moved.rootPath, moved.label, moved.workerId]).toEqual(["/repo", "laptop", workerId]);
    expect((await api.updateWorkspace({ workspaceId: ws.id, label: "main checkout" })).workspace?.rootPath).toBe(
      "/repo",
    );
    expect((await api.getThread({ threadId: thread.id })).thread?.cwd).toBe("/repo/repo-a");

    const second = (await api.createWorkspace({ projectId: moving, workerId, rootPath: "/repo/repo-a", label: "" }))
      .workspace!;

    expect(await failure(api.updateWorkspace({ workspaceId: second.id, rootPath: "/repo" }))).toContain(
      "already a workspace",
    );

    // Off the worker: gone from the overview and from new threads; the thread and its side threads go on.
    await api.removeWorkspace({ workspaceId: ws.id });
    const project = (await api.getOverview({})).projects.find((p) => p.id === moving)!;
    expect(project.workspaces.map((w) => w.id)).toEqual([second.id]);
    expect(
      await failure(api.createThread({ projectId: moving, workspaceId: ws.id, title: "x", provider: Provider.CODEX })),
    ).toContain("workspace not found");
    expect(await failure(api.updateWorkspace({ workspaceId: ws.id, label: "x" }))).toContain("workspace not found");
    expect(await failure(api.removeWorkspace({ workspaceId: ws.id }))).toContain("workspace not found");
    await api.sendMessage({ threadId: thread.id, text: "two", clientRequestId: "moving-2" });
    await watchUntil(api, thread.id, (u) => answers(u).includes("Echo: two"));

    const side = (
      await api.createThread({
        projectId: moving,
        workspaceId: ws.id,
        parentThreadId: thread.id,
        title: "Side",
        provider: Provider.CODEX,
        initialMessage: "side",
      })
    ).thread!;

    expect([side.workspaceId, side.cwd]).toEqual([ws.id, "/repo/repo-a"]);
    await watchUntil(api, side.id, (u) => answers(u).includes("Echo: side"));
  });

  test("a turn that lost its turn_finished is closed when the provider starts another one", async () => {
    const thread = (
      await api.createThread({
        projectId,
        workspaceId,
        title: "Lost finish",
        provider: Provider.CODEX,
        initialMessage: "x",
      })
    ).thread!;

    await watchUntil(api, thread.id, (u) => answers(u).includes("Echo: x"));
    const first = Bun.randomUUIDv7();
    const second = Bun.randomUUIDv7();
    // Two provider turns started, the first never finished (e.g. a provider crash between them).
    worker.emit(thread.id, first, {
      case: "turnStarted",
      value: { providerTurnRef: "p-1", origin: TurnOrigin.PROVIDER },
    });
    worker.emit(thread.id, second, {
      case: "turnStarted",
      value: { providerTurnRef: "p-2", origin: TurnOrigin.PROVIDER },
    });

    const snapshotTurns = async () => {
      const first = (await watchUntil(api, thread.id, (u) => u.length >= 1))[0];

      return first?.change.case === "snapshot" ? first.change.value.turns : [];
    };

    const turns = await eventually(snapshotTurns, (t) => t.length === 3 && t[2]?.status === "running");
    expect(turns.map((t) => [t.trigger, t.status])).toEqual([
      ["user", "completed"],
      ["provider", "interrupted"],
      ["provider", "running"],
    ]);
  });

  test("an event naming a turn the thread does not have creates no turn (Codex usage right after a fork)", async () => {
    const thread = (await api.createThread({ projectId, workspaceId, title: "Fork usage", provider: Provider.CODEX }))
      .thread!;

    await eventually(
      async () => (await api.listThreads({ projectId })).threads.find((t) => t.id === thread.id)?.status,
      (s) => s === "idle",
    );
    worker.emit(thread.id, Bun.randomUUIDv7(), { case: "usageUpdated", value: { usage: { inputTokens: 10n } } });
    await api.sendMessage({ threadId: thread.id, text: "after fork", clientRequestId: "fork-usage-1" });
    const updates = await watchUntil(api, thread.id, (u) => answers(u).includes("Echo: after fork"));
    expect(answers(updates)).toContain("Echo: after fork");

    const snapshotTurns = async () => {
      const first = (await watchUntil(api, thread.id, (u) => u.length >= 1))[0];

      return first?.change.case === "snapshot" ? first.change.value.turns : [];
    };

    const turns = await eventually(snapshotTurns, (t) => t.every((x) => x.status === "completed"));
    expect(turns.map((t) => [t.trigger, t.status])).toEqual([["user", "completed"]]);
  });

  test("thread details for the UI: GetThread, all threads, fork history, usage and notices survive a reload", async () => {
    const source = (
      await api.createThread({
        projectId,
        workspaceId,
        title: "Source",
        provider: Provider.CODEX,
        initialMessage: "remember me",
      })
    ).thread!;

    await watchUntil(api, source.id, (u) => answers(u).includes("Echo: remember me"));
    worker.emit(source.id, "", {
      case: "notice",
      value: { level: NoticeLevel.WARNING, code: "api_retry", message: "retrying" },
    });

    const details = (await api.getThread({ threadId: source.id })).thread!;
    expect([details.rootThreadId, details.interactionRoute, details.forkSourceThreadId]).toEqual([
      source.id,
      "human",
      "",
    ]);
    expect(details.lastActivityAt).toBeDefined();
    expect((await api.listThreads({ projectId: "" })).threads.map((t) => t.id)).toContain(source.id);

    // Usage and notices are part of the snapshot, not only of the live stream.
    const reloaded = await eventually(
      async () => (await watchUntil(api, source.id, (u) => u.length >= 1))[0],
      (u) =>
        u?.change.case === "snapshot" &&
        u.change.value.notices.length === 1 &&
        u.change.value.turns[0]?.status === "completed",
    );

    const snapshot = reloaded?.change.case === "snapshot" ? reloaded.change.value : undefined;
    expect(snapshot?.turns[0]?.usage?.outputTokens).toBe(2n);
    expect(snapshot?.notices[0]?.notice?.message).toBe("retrying");

    // A fork shows the history it inherits, marked as inherited.
    const fork = (
      await api.createThread({
        projectId,
        workspaceId,
        parentThreadId: source.id,
        fork: true,
        title: "Fork",
        provider: Provider.CODEX,
      })
    ).thread!;

    const forkDetails = (await api.getThread({ threadId: fork.id })).thread!;
    expect([forkDetails.forkSourceThreadId, forkDetails.rootThreadId]).toEqual([source.id, source.id]);
    const forkSnapshot = (await watchUntil(api, fork.id, (u) => u.length >= 1))[0];
    const inherited = forkSnapshot?.change.case === "snapshot" ? forkSnapshot.change.value : undefined;
    expect(inherited?.turns.map((t) => [t.inputText, t.inherited])).toEqual([["remember me", true]]);
    expect(
      inherited?.items
        .filter((i) => i.inherited)
        .map((i) => (i.item?.content.case === "agentMessage" ? i.item.content.value.text : "")),
    ).toContain("Echo: remember me");
  });

  test("fork from a turn: a new main thread up to that turn, lineage with the turn, ended turns only", async () => {
    const source = (
      await api.createThread({
        projectId,
        workspaceId,
        title: "Three turns",
        provider: Provider.CODEX,
        model: "gpt-6.1-sol",
        permissionMode: PermissionMode.ACCEPT_EDITS,
        initialMessage: "one",
      })
    ).thread!;

    await watchUntil(api, source.id, (u) => answers(u).includes("Echo: one"));
    await api.sendMessage({ threadId: source.id, text: "two", clientRequestId: "fork-turn-2" });
    await api.sendMessage({ threadId: source.id, text: "three", clientRequestId: "fork-turn-3" });

    const turnsOf = async (threadId: string) => {
      const first = (await watchUntil(api, threadId, (u) => u.length >= 1))[0];

      return first?.change.case === "snapshot" ? first.change.value.turns : [];
    };

    const turns = await eventually(
      () => turnsOf(source.id),
      (t) => t.filter((x) => x.status === "completed").length === 3,
    );

    const [t1, t2, t3] = turns;

    // Only the source and the turn: the fork takes its place and settings from the source.
    const fork = (await api.createThread({ forkThreadId: source.id, forkAtTurnId: t2!.id })).thread!;
    expect([fork.kind, fork.rootThreadId, fork.parentThreadId, fork.title]).toEqual([
      ui.ThreadKind.MAIN,
      fork.id,
      "",
      "Fork of Three turns",
    ]);
    expect([fork.forkSourceThreadId, fork.forkAfterTurnId, fork.forkAfterTurnOrdinal]).toEqual([source.id, t2!.id, 2]);
    expect([fork.projectId, fork.workspaceId, fork.cwd, fork.provider, fork.model, fork.permissionMode]).toEqual([
      projectId,
      workspaceId,
      source.cwd,
      Provider.CODEX,
      "gpt-6.1-sol",
      PermissionMode.ACCEPT_EDITS,
    ]);

    const command = await eventually(
      async () => worker.commands.find((c) => c.case === "createThread" && c.value.thread?.threadId === fork.id),
      (c) => c !== undefined,
    );

    const spec = command?.case === "createThread" ? command.value.fork : undefined;
    expect([spec?.sourceThreadId, spec?.afterTurnId, spec?.afterProviderTurnRef]).toEqual([
      source.id,
      t2!.id,
      `ct-${t2!.id.slice(-4)}`,
    ]);

    const inherited = await eventually(
      () => turnsOf(fork.id),
      (t) => t.length === 2,
    );

    expect(inherited.map((t) => [t.inputText, t.inherited])).toEqual([
      ["one", true],
      ["two", true],
    ]);

    // A fork of the fork at a turn it inherits forks the thread the turn belongs to.
    const again = (await api.createThread({ forkThreadId: fork.id, forkAtTurnId: t1!.id, title: "Again" })).thread!;
    expect([again.forkSourceThreadId, again.forkAfterTurnOrdinal, again.title]).toEqual([source.id, 1, "Again"]);
    // A turn past the fork point is not in the fork's history.
    expect(
      String(await api.createThread({ forkThreadId: fork.id, forkAtTurnId: t3!.id }).catch((cause: unknown) => cause)),
    ).toContain("not in this thread's history");

    // A running turn cannot be forked at; once interrupted it can (history up to that point).
    worker.holdTurns = true;

    const running = (await api.sendMessage({ threadId: source.id, text: "four", clientRequestId: "fork-turn-4" }))
      .turn!;

    await eventually(
      () => turnsOf(source.id),
      (t) => t.some((x) => x.id === running.id && x.status === "running"),
    );
    expect(
      String(
        await api.createThread({ forkThreadId: source.id, forkAtTurnId: running.id }).catch((cause: unknown) => cause),
      ),
    ).toContain("a fork starts after an ended turn");
    worker.holdTurns = false;
    worker.emit(source.id, running.id, {
      case: "turnFinished",
      value: { outcome: TurnOutcome.INTERRUPTED, providerTurnRef: `ct-${running.id.slice(-4)}` },
    });
    await eventually(
      () => turnsOf(source.id),
      (t) => t.some((x) => x.id === running.id && x.status === "interrupted"),
    );
    const atInterrupted = (await api.createThread({ forkThreadId: source.id, forkAtTurnId: running.id })).thread!;
    expect(atInterrupted.forkAfterTurnOrdinal).toBe(4);

    // A turn the provider never started has no fork point: refused, never the whole history instead.
    worker.handlers.set("startTurn", (_value, reply) => reply(false, { errorCode: "BUSY", errorMessage: "refused" }));

    const refused = (await api.sendMessage({ threadId: source.id, text: "five", clientRequestId: "fork-turn-5" }))
      .turn!;

    await eventually(
      () => turnsOf(source.id),
      (t) => t.some((x) => x.id === refused.id && x.status === "failed"),
    );
    worker.handlers.delete("startTurn");
    expect(
      String(
        await api.createThread({ forkThreadId: source.id, forkAtTurnId: refused.id }).catch((cause: unknown) => cause),
      ),
    ).toContain("never reached Codex");
  });

  test("settings live in the gateway: sections, versions across devices, project overrides, live updates", async () => {
    const initial = (await api.getSettings({})).user!;
    expect([initial.version, initial.appearance?.colorScheme, initial.threadDefaults?.workspaceId]).toEqual([
      0n,
      ui.ColorScheme.UNSPECIFIED,
      "",
    ]);

    const seen: ui.OverviewUpdate[] = [];
    const controller = new AbortController();

    const watching = (async () => {
      for await (const u of api.watchOverview({}, { signal: controller.signal })) seen.push(u);
    })().catch(() => {});

    await Bun.sleep(50);

    // Device A saves the appearance; the thread defaults section stays untouched.
    const a = (
      await api.updateUserSettings({
        appearance: {
          colorScheme: ui.ColorScheme.DARK,
          accent: ui.AccentTheme.GROVE,
          chatWidth: ui.ChatWidth.WIDE,
          lightTheme: ui.ColorTheme.FERN,
          darkTheme: ui.ColorTheme.HEATHER,
        },
        expectedVersion: 0n,
      })
    ).settings!;

    expect([a.version, a.appearance?.accent]).toEqual([1n, ui.AccentTheme.GROVE]);

    // Device B still has version 0: refused instead of overwriting A.
    const stale = await api
      .updateUserSettings({ appearance: { colorScheme: ui.ColorScheme.LIGHT }, expectedVersion: 0n })
      .catch((cause: unknown) => cause);

    expect((stale as ConnectError).code).toBe(Code.FailedPrecondition);

    const models = [
      { provider: Provider.CLAUDE, model: "claude-haiku-5-5" },
      { provider: Provider.CODEX, model: "gpt-6.1-sol" },
    ];

    const b = (
      await api.updateUserSettings({
        threadDefaults: { workspaceId, provider: Provider.CLAUDE, permissionMode: PermissionMode.ACCEPT_EDITS, models },
        expectedVersion: 1n,
      })
    ).settings!;

    expect([b.version, b.appearance?.colorScheme, b.threadDefaults?.provider]).toEqual([
      2n,
      ui.ColorScheme.DARK,
      Provider.CLAUDE,
    ]);
    expect(b.threadDefaults?.models.map((m) => m.model)).toEqual(["claude-haiku-5-5", "gpt-6.1-sol"]);
    // Another device changes a different section; both independent palettes survive the DB round trip.
    const persisted = (await api.getSettings({})).user?.appearance;
    expect([persisted?.lightTheme, persisted?.darkTheme]).toEqual([ui.ColorTheme.FERN, ui.ColorTheme.HEATHER]);
    expect(
      await failure(
        api.updateUserSettings({
          threadDefaults: { models: [models[0]!, { provider: Provider.CLAUDE, model: "x" }] },
          expectedVersion: 2n,
        }),
      ),
    ).toContain("one model per provider");
    expect(
      await failure(
        api.updateUserSettings({ threadDefaults: { workspaceId: Bun.randomUUIDv7() }, expectedVersion: 2n }),
      ),
    ).toContain("workspace not found");

    // The sidebar width is held within its limits (220…560 px, @canopy/domain); 0 stays "default".
    const look = { colorScheme: ui.ColorScheme.DARK, accent: ui.AccentTheme.GROVE, chatWidth: ui.ChatWidth.WIDE };

    const narrow = (await api.updateUserSettings({ appearance: { ...look, sidebarWidth: 40 }, expectedVersion: 2n }))
      .settings!;

    expect([narrow.appearance?.sidebarWidth, narrow.appearance?.accent]).toEqual([220, ui.AccentTheme.GROVE]);

    const wide = (await api.updateUserSettings({ appearance: { ...look, sidebarWidth: 9000 }, expectedVersion: 3n }))
      .settings!;

    expect(wide.appearance?.sidebarWidth).toBe(560);

    // Collapsing keeps the width for the way back.
    const collapsed = (
      await api.updateUserSettings({
        appearance: { ...look, sidebarWidth: 560, sidebarCollapsed: true },
        expectedVersion: 4n,
      })
    ).settings!;

    expect([collapsed.appearance?.sidebarCollapsed, collapsed.appearance?.sidebarWidth]).toEqual([true, 560]);

    const reset = (await api.updateUserSettings({ appearance: { ...look, sidebarWidth: 0 }, expectedVersion: 5n }))
      .settings!;

    expect([
      reset.version,
      reset.appearance?.sidebarWidth,
      reset.appearance?.sidebarCollapsed,
      (await api.getSettings({})).user?.appearance?.sidebarWidth,
    ]).toEqual([6n, 0, false, 0]);

    // Project settings override the user's defaults in that project.
    const project = (
      await api.updateProjectSettings({
        projectId,
        threadDefaults: { workspaceId, models: [{ provider: Provider.CODEX, model: "gpt-6.1-sol" }] },
        expectedVersion: 0n,
      })
    ).settings!;

    expect([project.version, project.threadDefaults?.models[0]?.model]).toEqual([1n, "gpt-6.1-sol"]);
    const all = await api.getSettings({});
    expect([all.user?.version, all.projects.map((p) => p.projectId)]).toEqual([6n, [projectId]]);

    await eventually(
      async () => seen,
      (u) =>
        u.filter((x) => x.change.case === "userSettings").length === 6 &&
        u.some((x) => x.change.case === "projectSettings"),
    );
    controller.abort();
    await watching;
  });

  test("CreateThread checks the provider and profile against the worker's report, and forks keep the provider", async () => {
    expect(
      await failure(api.createThread({ projectId, workspaceId, title: "x", provider: Provider.CLAUDE })),
    ).toContain("Claude is not available on laptop: claude CLI not found");
    expect(
      await failure(
        api.createThread({ projectId, workspaceId, title: "x", provider: Provider.CODEX, providerProfileId: "nope" }),
      ),
    ).toContain('Codex has no provider instance "nope"');

    // "native" and "" both name the native profile.
    const parent = (
      await api.createThread({
        projectId,
        workspaceId,
        title: "Codex parent",
        provider: Provider.CODEX,
        providerProfileId: "native",
      })
    ).thread!;

    expect(parent.providerProfileId).toBe("");

    // A fork into another provider is refused by the store rule too (through the API Claude is already refused above).
    const fork = create(ui.CreateThreadRequestSchema, {
      projectId,
      workspaceId,
      parentThreadId: parent.id,
      fork: true,
      title: "f",
      provider: Provider.CLAUDE,
    });

    const forkError = await gw.runtime
      .runPromise(GatewayStore.use((s) => s.createThread(gw.userId, fork)))
      .catch((cause: unknown) => cause);

    expect(String(forkError)).toContain("a fork keeps its parent's provider");
  });

  test("two scheduler passes at once start a queued turn once", async () => {
    const thread = (await api.createThread({ projectId, workspaceId, title: "Race", provider: Provider.CODEX }))
      .thread!;

    await eventually(
      async () => (await api.getThread({ threadId: thread.id })).thread?.status,
      (s) => s === "idle",
    );

    const turn = await gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.enqueueTurn({ threadId: thread.id, text: "once", userId: gw.userId, clientRequestId: "race-1" }),
      ),
    );

    await Promise.all([gw.core.pump(thread.id), gw.core.pump(thread.id), gw.core.pump(thread.id)]);
    const commands = await gw.runtime.runPromise(GatewayStore.use((s) => s.pendingCommands(gw.workerId)));

    const delivered = await eventually(
      async () => (await watchUntil(api, thread.id, (u) => answers(u).includes("Echo: once"))).length,
      (n) => n > 0,
    );

    expect(delivered).toBeGreaterThan(0);
    const starts = commands.filter((c) => c.kind.case === "startTurn" && c.kind.value.turnId === turn.id);
    expect(starts.length).toBeLessThanOrEqual(1);

    const echoes = await eventually(
      async () => {
        const first = (await watchUntil(api, thread.id, (u) => u.length >= 1))[0];

        return first?.change.case === "snapshot"
          ? first.change.value.items.filter((i) => i.item?.content.case === "agentMessage").length
          : 0;
      },
      (n) => n >= 1,
    );

    expect(echoes).toBe(1); // the worker ran the turn once
  });

  test("errors keep their meaning across the API", async () => {
    expect(await failure(api.createProject({ name: "  " }))).toContain("project name is required");
    expect(await failure(api.sendMessage({ threadId: Bun.randomUUIDv7(), text: "x" }))).not.toBe("");
  });
});

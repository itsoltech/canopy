import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { JsonObject } from "@canopy/domain";
import { randomBytes } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import { InteractionKind, PermissionMode, Provider, ui, computerLink as link } from "@canopy/contracts";
import { nodeRef, REMOTE_THREADS } from "@canopy/domain/computers";
import { dockerAvailable } from "@canopy/db/testing";
import { AsyncChannel } from "@canopy/transport";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { linkedComputers } from "./support/computers.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { methodNamed } from "../../apps/gateway/src/computers/remote.ts";
import { linkClient } from "../../apps/gateway/src/computers/transport.ts";
import {
  answers,
  eventually as poll,
  failure,
  startTestGateway,
  watchUntil,
  type TestGateway,
} from "./support/gateway.ts";

async function eventually(predicate: () => Promise<boolean>, timeoutMs = 5000) {
  expect(await poll(predicate, Boolean, timeoutMs)).toBe(true);
}

const id = () => crypto.randomUUID();

/** Listeners keep their port across the listener toggle, as configured computers do. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

/** Stage 2 of docs/linked-computers.md: computer A shows and drives threads whose home is computer B. */
describe.skipIf(!dockerAvailable)("remote threads across two linked gateways", () => {
  let a: TestGateway;
  let b: TestGateway;
  let sa: ComputerStore;
  let sb: ComputerStore;
  let la: LinkedComputers;
  let lb: LinkedComputers;
  let project = "";
  let workspace = "";
  let bNode = "";
  const q = (value: string) => `${value}~${nodeRef(bNode)}`;

  const linkedB = (extra: Partial<ConstructorParameters<typeof LinkedComputers>[0]> = {}, port = 0) =>
    linkedComputers({
      store: sb,
      host: "127.0.0.1",
      port,
      heartbeatMs: 100,
      serve: remoteServe(uiHandlers(b.core)),
      capabilities: ["presence", "unlink", REMOTE_THREADS],
      ...extra,
    });

  async function restartB(extra: Partial<ConstructorParameters<typeof LinkedComputers>[0]> = {}) {
    const port = Number(new URL(lb.addresses[0]!).port);
    await lb.close();
    lb = linkedB(extra, port);
    b.core.computers = lb;
    b.core.network = lb.options.network;
    await lb.start();
  }

  const reachable = () =>
    eventually(async () => la.reachable().includes(bNode) && lb.reachable().includes(la.hello().nodeId), 15_000);

  beforeAll(async () => {
    a = await startTestGateway({ role: "desktop" });
    b = await startTestGateway({ role: "desktop" });
    sa = new ComputerStore(a.runtime, a.userId, randomBytes(32));
    sb = new ComputerStore(b.runtime, b.userId, randomBytes(32));
    la = linkedComputers({
      store: sa,
      host: "127.0.0.1",
      port: await freePort(),
      heartbeatMs: 100,
      serve: remoteServe(uiHandlers(a.core)),
      capabilities: ["presence", "unlink", REMOTE_THREADS],
    });
    lb = linkedB({}, await freePort());
    a.core.computers = la;
    a.core.network = la.options.network;
    b.core.computers = lb;
    b.core.network = lb.options.network;
    await la.start();
    await lb.start();
    bNode = lb.hello().nodeId;
    const invitation = await a.api.createComputerPairing({});
    await b.api.linkComputer({ address: la.addresses[0]!, code: invitation.code });
    await reachable();
    project = (await b.api.createProject({ name: "Laptop project" })).project!.id;
    workspace = (
      await b.api.createWorkspace({
        projectId: project,
        workerId: b.workerId,
        rootPath: "/repo/repo-a",
        label: "laptop",
      })
    ).workspace!.id;
  }, 90_000);
  afterAll(async () => {
    await Promise.allSettled([la?.close(), lb?.close()]);
    await a?.close();
    await b?.close();
  }, 20_000);

  test("A's overview lists B's workers and projects next to its own, qualified and marked with B's machine", async () => {
    const overview = await a.api.getOverview({});
    const worker = overview.workers.find((w) => w.id === q(b.workerId));
    expect(worker?.nodeId).toBe(bNode);
    expect(overview.workers.find((w) => w.id === a.workerId)?.nodeId).toBe("");
    expect(overview.projects.find((p) => p.id === q(project))?.workspaces.map((w) => [w.id, w.workerId])).toEqual([
      [q(workspace), q(b.workerId)],
    ]);
    expect(overview.computers.map((c) => [c.nodeId, c.status, c.capabilities.includes(REMOTE_THREADS)])).toEqual([
      [bNode, "connected", true],
    ]);
    // B serves only its own: A's worker does not come back to A through B.
    expect(overview.workers.filter((w) => w.id.includes("~")).every((w) => w.id.endsWith(`~${nodeRef(bNode)}`))).toBe(
      true,
    );
    expect(overview.workers.filter((w) => w.id.startsWith(a.workerId))).toHaveLength(1);
    const models = await a.api.listModels({});
    expect(models.workers.some((w) => w.workerId === q(b.workerId))).toBe(true);
  }, 20_000);

  let thread = "";
  test("a thread created from A on B's worker lives on B and streams back live", async () => {
    const created = (
      await a.api.createThread({
        projectId: q(project),
        workspaceId: q(workspace),
        title: "From A",
        provider: Provider.CODEX,
        permissionMode: PermissionMode.ASK,
        initialMessage: "hello from A",
        clientRequestId: id(),
      })
    ).thread!;

    thread = created.id;
    expect(thread.endsWith(`~${nodeRef(bNode)}`)).toBe(true);
    expect(created.nodeId).toBe(bNode);
    const plain = thread.split("~")[0]!;
    expect((await b.api.getThread({ threadId: plain })).thread?.title).toBe("From A");
    expect(b.worker.created.some((c) => c.threadId === plain)).toBe(true);
    // A's own database holds no copy.
    expect(await failure(a.core.getThread(plain))).toBeTruthy();
    const updates = await watchUntil(a.api, thread, (u) => answers(u).includes("Echo: hello from A"));
    const snapshot = updates[0]?.change.case === "snapshot" ? updates[0].change.value : undefined;
    expect(snapshot?.thread?.id).toBe(thread);
    expect(
      (await a.api.listThreads({ sidebarOnly: true })).threads.some((t) => t.id === thread && t.nodeId === bNode),
    ).toBe(true);
    expect((await a.api.listThreads({ projectId: q(project) })).threads.map((t) => t.id)).toEqual([thread]);
  }, 25_000);

  test("send, steer, queue and interrupt from A are applied on B; effects come back through the stream", async () => {
    b.worker.holdTurns = true;
    const plain = thread.split("~")[0]!;
    const sent = await a.api.sendMessage({ threadId: thread, text: "long task", clientRequestId: id() });
    const running = sent.turn!.id;
    expect(running.endsWith(`~${nodeRef(bNode)}`)).toBe(true);
    await eventually(async () => (await b.api.getThread({ threadId: plain })).thread?.status === "running");

    const steer = await a.api.sendMessage({
      threadId: thread,
      text: "also this",
      clientRequestId: id(),
      delivery: ui.MessageDelivery.STEER,
    });

    expect(steer.steer).toBeDefined();
    await eventually(async () => [...b.worker.steered.values()].includes("also this"));
    const queued = (await a.api.sendMessage({ threadId: thread, text: "later", clientRequestId: id() })).turn!;
    expect(queued.status).toBe("queued");
    await a.api.deleteQueuedTurn({ turnId: queued.id });
    const watched = await watchUntil(a.api, thread, (u) => u.some((x) => x.change.case === "snapshot"));
    const turns = watched[0]?.change.case === "snapshot" ? watched[0].change.value.turns : [];
    expect(turns.find((t) => t.id === queued.id)?.withdrawn).toBe("deleted");
    await a.api.interruptThread({ threadId: thread });
    await eventually(async () =>
      b.worker.commands.some((c) => c.case === "interruptTurn" && c.value.threadId === plain),
    );
    b.worker.finish(plain, running.split("~")[0]!);
    b.worker.holdTurns = false;
  }, 25_000);

  test("approvals asked on B are answered from A and reach B's worker", async () => {
    const plain = thread.split("~")[0]!;
    const requestId = id();

    const updates = await watchUntil(
      a.api,
      thread,
      (u) => u.some((x) => x.change.case === "interaction" && x.change.value.status === "allowed"),
      (update) => {
        if (update.change.case === "snapshot")
          b.worker.ask({
            requestId,
            threadId: plain,
            kind: InteractionKind.PERMISSION,
            toolName: "shell",
            requestJson: "{}",
          });

        if (update.change.case === "interaction" && update.change.value.status === "pending") {
          expect(update.change.value.requestId).toBe(q(requestId));
          void a.api.answerInteraction({ requestId: update.change.value.requestId, allow: true });
        }
      },
    );

    expect(updates.some((u) => u.change.case === "interaction")).toBe(true);
    await eventually(async () => b.worker.interactionAnswers.some((x) => x.requestId === requestId && x.allow));
  }, 20_000);

  test("a file attached on A travels with the message to B", async () => {
    const file = (await a.api.uploadAttachment({ name: "notes.txt", data: new TextEncoder().encode("remote notes") }))
      .attachment!;

    const turn = (
      await a.api.sendMessage({ threadId: thread, text: "see file", clientRequestId: id(), attachmentIds: [file.id] })
    ).turn!;

    expect(turn.attachments.map((x) => [x.name, x.id.endsWith(`~${nodeRef(bNode)}`)])).toEqual([["notes.txt", true]]);
    await eventually(async () => (b.worker.attachments.get(turn.id.split("~")[0]!) ?? []).length === 1);
  }, 20_000);

  test("A's live overview follows B's threads and B's presence", async () => {
    const controller = new AbortController();
    const seen: ui.OverviewUpdate[] = [];

    const reading = (async () => {
      try {
        for await (const u of a.api.watchOverview({}, { signal: controller.signal })) seen.push(u);
      } catch {
        /* aborted */
      }
    })();

    try {
      await eventually(async () => seen.some((u) => u.change.case === "thread" && u.change.value.id === thread));

      const direct = (
        await b.api.createThread({
          projectId: project,
          workspaceId: workspace,
          title: "On B",
          provider: Provider.CODEX,
          clientRequestId: id(),
        })
      ).thread!;

      await eventually(async () =>
        seen.some(
          (u) => u.change.case === "thread" && u.change.value.id === q(direct.id) && u.change.value.nodeId === bNode,
        ),
      );
      await lb.announce("updating");
      await eventually(async () =>
        seen.some((u) => u.change.case === "computer" && u.change.value.status === "updating"),
      );
      await lb.announce("connected");
      await reachable();
    } finally {
      controller.abort();
      await reading;
    }
  }, 25_000);

  test("an unreachable partner fails fast with a clear reason and no work waits for it", async () => {
    const plain = thread.split("~")[0]!;
    const before = (b.worker.inputs.get(plain) ?? []).length;
    await b.api.updateNetworkAccess({ action: "set_enabled", enabled: false });
    await a.api.updateNetworkAccess({ action: "set_enabled", enabled: false });
    await eventually(async () => (await a.api.getComputers({})).peers[0]?.status === "unreachable", 10_000);
    const started = Date.now();
    expect(await failure(a.api.sendMessage({ threadId: thread, text: "while away", clientRequestId: id() }))).toMatch(
      /is unreachable since \d{1,2}:\d\d/,
    );
    expect(await failure(a.api.answerInteraction({ requestId: q(id()), allow: true }))).toContain("unreachable");
    expect(Date.now() - started).toBeLessThan(1500);
    expect((await a.api.getOverview({})).workers.some((w) => w.nodeId)).toBe(false);
    expect((await a.api.listThreads({})).threads.some((t) => t.nodeId)).toBe(false);
    await a.api.updateNetworkAccess({ action: "set_enabled", enabled: true });
    await b.api.updateNetworkAccess({ action: "set_enabled", enabled: true });
    await reachable();
    await Bun.sleep(300);
    expect((b.worker.inputs.get(plain) ?? []).length).toBe(before);
    const snapshot = await watchUntil(b.api, plain, (u) => u.length > 0);
    const turns = snapshot[0]?.change.case === "snapshot" ? snapshot[0].change.value.turns : [];
    expect(turns.some((t) => t.inputText.includes("while away"))).toBe(false);
  }, 40_000);

  test("a partner without remote threads shows that it needs an update", async () => {
    await restartB({ capabilities: ["presence", "unlink"] });
    await eventually(async () => (await a.api.getComputers({})).peers[0]?.status === "connected", 15_000);
    expect((await a.api.getComputers({})).peers[0]!.capabilities).toEqual(["presence", "unlink"]);
    expect(await failure(a.api.getThread({ threadId: thread }))).toContain("needs an update to share its threads");
    expect((await a.api.getOverview({})).workers.some((w) => w.nodeId)).toBe(false);
    await restartB();
    await reachable();
  }, 40_000);

  test("only thread actions cross the link; requests that point elsewhere are refused", async () => {
    const aNode = la.hello().nodeId;

    const call = async (name: string, request: JsonObject) => {
      const method = methodNamed(name)!;

      for await (const m of lb.remote(aNode, method, create(method.input, request), AbortSignal.timeout(5000)))
        return m;

      return undefined;
    };

    expect(await failure(call("GetSettings", {}))).toContain("does not share");
    expect(await failure(call("ListProviderInstances", {}))).toContain("does not share");
    expect(await failure(call("GetThread", { threadId: `${id()}~${nodeRef(bNode)}` }))).toContain("another computer");
    expect(await failure(a.api.answerThreadSecret({ requestId: q(id()), value: "secret" }))).toBeTruthy();
    expect(await failure(a.api.listSchedules({ threadId: thread }))).toContain("another computer");
  }, 20_000);

  test("after unlink neither side can reach the other's threads, including over a raw pinned stream", async () => {
    const aNode = la.hello().nodeId;
    await a.api.manageComputer({ action: "unlink", nodeId: bNode });
    await eventually(async () => !(await b.api.getComputers({})).peers.length);
    expect(await failure(a.api.getThread({ threadId: thread }))).toContain("no longer linked");
    expect(await failure(b.api.getThread({ threadId: `${id()}~${nodeRef(aNode)}` }))).toContain("no longer linked");
    expect((await a.api.getOverview({})).workers.some((w) => w.nodeId)).toBe(false);
    // B still has its old key and A's certificate; A only answers Unlinked and serves nothing.
    const frames = new AsyncChannel<link.LinkFrame>();
    frames.push(create(link.LinkFrameSchema, { body: { case: "hello", value: lb.hello() } }));
    frames.push(
      create(link.LinkFrameSchema, {
        body: { case: "remoteRequest", value: { callId: 1n, method: "GetOverview", payload: new Uint8Array() } },
      }),
    );
    const received: string[] = [];

    try {
      for await (const frame of linkClient(la.addresses[0]!, la.identity.certificate, lb.identity).connect(frames, {
        timeoutMs: 3000,
      }))
        received.push(frame.body.case ?? "");
    } catch {
      /* closed */
    } finally {
      frames.close();
    }

    expect(received).toEqual(["unlinked"]);
  }, 25_000);
});

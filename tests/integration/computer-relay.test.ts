import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { create, type Message } from "@bufbuild/protobuf";
import { bots, computerLink as link, InteractionKind, PermissionMode, Provider, ProviderProfileKind, ui } from "@canopy/contracts";
import { qualifyId, RELAY, REMOTE_THREADS, THREAD_MIRROR } from "@canopy/domain/computers";
import { dockerAvailable } from "@canopy/db/testing";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { AsyncChannel } from "@canopy/transport";
import { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { methodNamed, RemoteCalls, type RelayRoute } from "../../apps/gateway/src/computers/remote.ts";
import { linkClient } from "../../apps/gateway/src/computers/transport.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

const id = () => crypto.randomUUID();
describe.skipIf(!dockerAvailable)("Share onward: three real gateways and independent databases", () => {
  let w: TestGateway; let p1: TestGateway; let p2: TestGateway;
  let lw: LinkedComputers; let l1: LinkedComputers; let l2: LinkedComputers;
  let wn = ""; let n1 = ""; let n2 = ""; let project = ""; let workspace = ""; let thread = ""; let parent = ""; let bot = "";
  const q = (value: string) => qualifyId(value, n2);
  const runtime = (gw: TestGateway, port = 0, capabilities?: string[]) => new LinkedComputers({ store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey), host: "127.0.0.1", port,
    heartbeatMs: 150, serve: remoteServe(uiHandlers(gw.core), gw.core), ...(capabilities && { capabilities }) });
  const ready = async () => expect(await eventually(async () => lw.reachable().includes(n1) && l1.reachable().includes(n2) && l2.reachable().includes(n1), Boolean, 15000)).toBe(true);
  const share = () => p1.api.manageComputer({ action: "share_onward", nodeId: wn, shareOnwardNodeIds: [n2] });
  const relayed = async () => expect(await eventually(async () => lw.reachable().includes(n2) && l2.canCall(wn), Boolean, 15000)).toBe(true);
  const tool = (name: string, args: unknown) => w.worker.callTool({ threadId: parent, tool: name, args });

  /** An authenticated partner bypassing the UI, including deliberately forged envelopes. */
  async function raw(route: RelayRoute, name = "GetOverview", request: Message = create(ui.GetOverviewRequestSchema)) {
    const output = new AsyncChannel<link.LinkFrame>(); const stop = new AbortController();
    const hello = Promise.withResolvers<void>();
    const calls = new RemoteCalls({ send: (frame) => output.push(create(link.LinkFrameSchema, frame)), allowed: async () => true, name: () => "P1" });
    const peer = (await lw.store.peer(n1))!;
    output.push(create(link.LinkFrameSchema, { body: { case: "hello", value: lw.hello() } }));
    const reader = (async () => {
      try {
        for await (const f of linkClient(l1.addresses[0]!, peer.certificate, lw.identity).connect(output, { signal: stop.signal })) {
          if (f.body.case === "welcome") hello.resolve();
          else calls.receive(f.body);
        }
      } catch (e) { hello.reject(e); } finally { calls.close(); }
    })();
    try {
      await hello.promise;
      for await (const result of calls.call(methodNamed(name)!, request, AbortSignal.timeout(5000), route)) return result;
    } finally { output.close(); stop.abort(); calls.close(); await reader; }
    return undefined;
  }

  beforeAll(async () => {
    w = await startTestGateway(); p1 = await startTestGateway(); p2 = await startTestGateway({ botModel: async (i) => ({ text: `P2: ${i.messages.findLast((m) => m.role === "user")?.text}`, calls: [] }) });
    lw = runtime(w); l1 = runtime(p1); l2 = runtime(p2);
    w.core.computers = lw; p1.core.computers = l1; p2.core.computers = l2;
    await lw.start(); await l1.start(); await l2.start();
    wn = lw.hello().nodeId; n1 = l1.hello().nodeId; n2 = l2.hello().nodeId;
    for (const [gw, name] of [[w, "W"], [p1, "P1"], [p2, "P2"]] as const) await gw.api.manageComputer({ action: "rename", name });
    const first = await p1.api.createComputerPairing({}); await w.api.linkComputer({ address: l1.addresses[0]!, code: first.code });
    const second = await p1.api.createComputerPairing({}); await p2.api.linkComputer({ address: l1.addresses[0]!, code: second.code }); await ready();
    project = (await p2.api.createProject({ name: "Private P2" })).project!.id;
    workspace = (await p2.api.createWorkspace({ projectId: project, workerId: p2.workerId, rootPath: "/repo", label: "P2 workspace" })).workspace!.id;
    thread = (await p2.api.createThread({ projectId: project, workspaceId: workspace, title: "P2 thread", provider: Provider.CODEX, permissionMode: PermissionMode.ASK, clientRequestId: id() })).thread!.id;
    const wp = (await w.api.createProject({ name: "W" })).project!.id;
    const ws = (await w.api.createWorkspace({ projectId: wp, workerId: w.workerId, rootPath: "/repo", label: "W" })).workspace!.id;
    parent = (await w.api.createThread({ projectId: wp, workspaceId: ws, title: "W parent", provider: Provider.CODEX, clientRequestId: id() })).thread!.id;
    await p2.api.saveProviderInstance({ harness: Provider.CODEX, id: "relay-fixture", label: "Fixture", create: true, kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: "http://127.0.0.1:1", apiKey: "fixture", allWorkers: true });
    await p2.api.setInstanceModels({ harness: Provider.CODEX, id: "relay-fixture", models: { custom: ["gpt-6.1-sol"] } });
    bot = (await p2.api.createBot({ configuration: { name: "P2 bot", shape: "round", color: "#22aaff", provider: Provider.CODEX, providerInstance: "relay-fixture", model: "gpt-6.1-sol", approvalPolicy: "safe" }, clientRequestId: id() })).bot!.id;
    p2.core.bots.start();
  }, 90000);
  afterAll(async () => {
    await Promise.allSettled([lw?.close(), l1?.close(), l2?.close()]);
    await w?.close(); await p1?.close(); await p2?.close();
  }, 30000);
  afterEach(() => { if (p2) p2.worker.holdTurns = false; });

  test("links are not transitive by default, including a raw authenticated request", async () => {
    expect((await w.api.getComputers({})).peers.some((p) => p.nodeId === n2)).toBe(false);
    expect((await w.api.listThreads({})).threads.some((t) => t.id === q(thread))).toBe(false);
    expect(await failure(w.api.getThread({ threadId: q(thread) }))).toContain("no longer linked");
    expect(await failure(raw({ targetNodeId: n2, originNodeId: "", relayHops: 0 }))).toContain("not enabled");
  });

  test("sharing exposes the real home via P1 and an informational W via P1 on P2", async () => {
    await share(); await relayed();
    const peer = (await w.api.getComputers({})).peers.find((p) => p.nodeId === n2)!;
    expect(peer.viaNodeId).toBe(n1); expect(peer.viaName).toBe("P1"); expect(peer.status).toBe("connected");
    expect(peer.routes).toEqual([]); expect(peer.addresses).toEqual([]); expect(peer.fingerprint).toBe("");
    expect(peer.capabilities).not.toContain(RELAY); expect(peer.capabilities).not.toContain("shared_config");
    const origin = (await p2.api.getComputers({})).peers.find((p) => p.nodeId === wn)!;
    expect(origin.viaNodeId).toBe(n1); expect(origin.relayOrigin).toBe(true); expect(origin.name).toBe("W");
    expect(l2.reachable()).not.toContain(wn);
    expect(await l2.store.peer(wn)).toBeUndefined(); // never an mTLS trust pin
    expect((await w.api.listThreads({})).threads.find((t) => t.id === q(thread))?.nodeId).toBe(n2);
    expect((await w.api.getOverview({})).projects.find((p) => p.id === q(project))?.nodeId).toBe(n2);
  });

  test("explicit reciprocal sharing permits both directions without a routing loop", async () => {
    await p1.api.manageComputer({ action: "share_onward", nodeId: n2, shareOnwardNodeIds: [wn] });
    expect(await eventually(async () => l2.reachable().includes(wn), Boolean)).toBe(true);
    expect((await p2.api.getThread({ threadId: qualifyId(parent, wn) })).thread?.title).toBe("W parent");
    expect((await w.api.getThread({ threadId: q(thread) })).thread?.title).toBe("P2 thread");
    expect(await eventually(async () => Boolean((await l2.mirror.state(wn))?.cursor), Boolean, 10000)).toBe(true);
    await p1.api.manageComputer({ action: "share_onward", nodeId: n2, shareOnwardNodeIds: [] });
    expect(await eventually(async () => !l2.reachable().includes(wn) && l2.canCall(wn), Boolean)).toBe(true);
    expect(await l2.mirror.state(wn)).toBeUndefined();
    expect((await w.api.getThread({ threadId: q(thread) })).thread?.title).toBe("P2 thread");
  }, 15000);

  test("reads, writes, steer, attachments and approvals execute only at P2", async () => {
    expect((await w.api.getThread({ threadId: q(thread) })).thread?.title).toBe("P2 thread");
    p2.worker.holdTurns = true;
    const sent = await w.api.sendMessage({ threadId: q(thread), text: "relayed message", clientRequestId: id() });
    expect(await eventually(async () => p2.worker.started.has(sent.turn!.id.split("~")[0]!), Boolean)).toBe(true);
    expect(await eventually(async () => (await p2.api.getThread({ threadId: thread })).thread?.status === "running", Boolean)).toBe(true);
    await w.api.sendMessage({ threadId: q(thread), text: "relayed steer", delivery: ui.MessageDelivery.STEER, clientRequestId: id() });
    expect(await eventually(async () => [...p2.worker.steered.values()].includes("relayed steer"), Boolean)).toBe(true);
    const approval = id(); p2.worker.ask({ requestId: approval, threadId: thread, kind: InteractionKind.PERMISSION, toolName: "shell", requestJson: "{}" });
    expect(await eventually(async () => (await p2.core.linkedAgents.snapshot(thread)).interactions.some((i) => i.requestId === approval), Boolean)).toBe(true);
    await w.api.answerInteraction({ requestId: q(approval), allow: true });
    expect(await eventually(async () => p2.worker.interactionAnswers.some((a) => a.requestId === approval && a.allow), Boolean)).toBe(true);
    p2.worker.finish(thread, sent.turn!.id.split("~")[0]!, "relay finished"); p2.worker.holdTurns = false;
    const file = (await w.api.uploadAttachment({ name: "relay.txt", data: new TextEncoder().encode("relay attachment") })).attachment!.id;
    await w.api.sendMessage({ threadId: q(thread), text: "with file", attachmentIds: [file], clientRequestId: id() });
    expect(await eventually(async () => [...p2.worker.attachments.values()].some((a) => a.some((f) => f.name === "relay.txt")), Boolean)).toBe(true);
    expect(await failure(w.core.getThread(thread))).toBeTruthy(); expect(await failure(p1.core.getThread(thread))).toBeTruthy();
  }, 20000);

  test("P2 bots and agent spawn use the originating W identity; callbacks return via P1", async () => {
    expect((await w.api.listBots({})).bots.some((b) => b.id === q(bot))).toBe(true);
    await w.api.sendBotMessage({ botId: q(bot), text: "relay bot message", clientRequestId: id() });
    expect(await eventually(async () => (await p2.core.bots.run((s) => s.conversation(p2.userId, bot))).messages.some((m) => m.text === "P2: relay bot message"), Boolean)).toBe(true);
    const result = await tool("spawn_thread", { workspace_id: q(workspace), project_id: q(project), title: "Relay child", prompt: "relay child result", provider: "codex/native" });
    if (result.isError) throw new Error(result.content);
    const child = JSON.parse(result.resultJson).thread_id.split("~")[0];
    expect((await p2.api.getThread({ threadId: child })).thread?.parentThreadId).toBe(qualifyId(parent, wn));
    expect(await eventually(async () => (w.worker.inputs.get(parent) ?? []).some((v) => v.includes("relay child result")), Boolean, 10000)).toBe(true);
    const rows = await l2.store.query<{ peer_node_id: string }>("SELECT peer_node_id FROM computer_agent_calls WHERE owner_user_id=$1::uuid AND target_id=$2::uuid", [p2.userId, child]);
    expect(rows[0]?.peer_node_id).toBe(wn);
    expect(await failure(l2.remote(wn, methodNamed("GetOverview")!, create(ui.GetOverviewRequestSchema), AbortSignal.timeout(2000)).next())).toContain("read only");
  }, 20000);

  test("no secret/configuration relay, forged origin, loops or second relay hop", async () => {
    const empty = create(link.SharedConfigPushSchema);
    expect(await failure(raw({ targetNodeId: n2, originNodeId: "", relayHops: 0 }, "PushSharedConfig", empty))).toContain("cannot be relayed");
    for (const route of [
      { targetNodeId: n2, originNodeId: wn, relayHops: 1 },
      { targetNodeId: n2, originNodeId: "", relayHops: 2 },
      { targetNodeId: wn, originNodeId: "", relayHops: 0 },
      { targetNodeId: n1, originNodeId: "", relayHops: 0 },
      { targetNodeId: n2, originNodeId: wn, relayHops: 0 },
    ]) expect(await failure(raw(route))).toMatch(/hop limit|loop/);
    expect(await failure(w.api.manageComputer({ action: "share_onward", nodeId: n1, shareOnwardNodeIds: [n2] }))).toContain("direct partners");
    expect(await failure(p2.api.manageComputer({ action: "share_onward", nodeId: n1, shareOnwardNodeIds: [wn] }))).toContain("direct partners");
  }, 15000);

  test("unticking aborts an in-flight call and purges both mirrors and all listings", async () => {
    expect(await eventually(async () => Boolean((await lw.mirror.state(n2))?.cursor) && (await lw.botMirror.conversations(n2)).some((c) => c.bot?.id === q(bot)), Boolean, 15000)).toBe(true);
    const controller = new AbortController(); const updates: ui.OverviewUpdate[] = [];
    const reading = (async () => {
      try { for await (const update of w.api.watchOverview({}, { signal: controller.signal })) updates.push(update); }
      catch { /* explicitly stopped below */ }
    })();
    try {
      expect(await eventually(async () => updates.some((u) => u.change.case === "computerSnapshot" && u.change.value.nodeId === n2), Boolean)).toBe(true);
      p2.worker.handlers.set("listDirectory", () => {});
      const before = p2.worker.commands.length;
      const staleRevision = BigInt((await lw.store.peer(n1))!.relay_revision);
      const pending = failure(w.api.listDirectory({ workerId: q(p2.workerId), path: "/repo/relay-wait" }));
      expect(await eventually(async () => p2.worker.commands.slice(before).some((c) => c.case === "listDirectory"), Boolean)).toBe(true);
      await p1.api.manageComputer({ action: "share_onward", nodeId: wn, shareOnwardNodeIds: [] });
      expect(await pending).toMatch(/revoked|no longer linked/);
      p2.worker.handlers.delete("listDirectory");
      expect(await eventually(async () => !(await w.api.getComputers({})).peers.some((p) => p.nodeId === n2), Boolean)).toBe(true);
      expect((await w.api.listThreads({})).threads.some((t) => t.nodeId === n2)).toBe(false);
      expect((await w.api.listBots({})).bots.some((b) => b.nodeId === n2)).toBe(false);
      expect(await lw.mirror.state(n2)).toBeUndefined(); expect(await lw.botMirror.conversations(n2)).toEqual([]);
      expect(await failure(w.api.sendMessage({ threadId: q(thread), text: "revoked", clientRequestId: id() }))).toContain("no longer linked");
      expect(await eventually(async () => !(await p2.api.getComputers({})).peers.some((p) => p.nodeId === wn), Boolean)).toBe(true);
      // An older catalog from the other simultaneous stream cannot restore trust.
      await lw.relay.receive(n1, create(link.RelayCatalogSchema, { revision: staleRevision, computers: [{ nodeId: n2, name: "P2", status: "connected", statusSinceMs: BigInt(Date.now()), role: "home", capabilities: [REMOTE_THREADS, THREAD_MIRROR] }] }));
      expect(await lw.store.computer(n2)).toBeUndefined();
      expect(await eventually(async () => updates.some((u) => u.change.case === "computerRemoved" && u.change.value === n2), Boolean)).toBe(true);
      const removed = updates.findIndex((u) => u.change.case === "computerRemoved" && u.change.value === n2);
      expect(updates.slice(removed + 1).some((u) => (u.change.case === "computerSnapshot" || u.change.case === "computer") && u.change.value.nodeId === n2)).toBe(false);
    } finally { controller.abort(); await reading; }
  }, 25000);

  test("P1 offline preserves read-only history with a clear reason and never queues work", async () => {
    await share(); await relayed();
    expect(await eventually(async () => Boolean((await lw.mirror.state(n2))?.cursor), Boolean, 10000)).toBe(true);
    const port = Number(new URL(l1.addresses[0]!).port); await l1.close();
    expect(await eventually(async () => !lw.reachable().includes(n2), Boolean)).toBe(true);
    const peer = (await w.api.getComputers({})).peers.find((p) => p.nodeId === n2)!;
    expect(peer.unavailableReason).toContain("Available through P1, which is unreachable since");
    expect((await w.api.getThread({ threadId: q(thread) })).thread?.id).toBe(q(thread));
    const started = Date.now();
    expect(await failure(w.api.sendMessage({ threadId: q(thread), text: "must never queue", clientRequestId: id() }))).toContain("Available through P1");
    expect(Date.now() - started).toBeLessThan(1500);
    const wport = Number(new URL(lw.addresses[0]!).port); await lw.close();
    lw = runtime(w, wport); w.core.computers = lw; await lw.start();
    expect((await w.api.getThread({ threadId: q(thread) })).thread?.id).toBe(q(thread));
    expect((await w.api.getComputers({})).peers.find((p) => p.nodeId === n2)?.unavailableReason).toContain("Available through P1");
    l1 = runtime(p1, port); p1.core.computers = l1; await l1.start(); await ready(); await relayed();
    expect((p2.worker.inputs.get(thread) ?? []).some((v) => v.includes("must never queue"))).toBe(false);
  }, 30000);

  test("capability downgrade removes access and rejects new onward grants", async () => {
    const port = Number(new URL(l2.addresses[0]!).port); await l2.close();
    l2 = runtime(p2, port, ["presence", "unlink", REMOTE_THREADS, THREAD_MIRROR]); p2.core.computers = l2; await l2.start(); await ready();
    expect(await eventually(async () => !(await w.api.getComputers({})).peers.some((p) => p.nodeId === n2), Boolean, 10000)).toBe(true);
    expect(await failure(share())).toContain("need an update");
    await l2.close(); l2 = runtime(p2, port); p2.core.computers = l2; await l2.start(); await ready(); await relayed();
  }, 30000);

  test("unlinking P1–P2 revokes W's access and clears its mirrors", async () => {
    await p1.api.manageComputer({ action: "unlink", nodeId: n2 });
    expect(await eventually(async () => !(await w.api.getComputers({})).peers.some((p) => p.nodeId === n2), Boolean)).toBe(true);
    expect(await lw.mirror.state(n2)).toBeUndefined(); expect(await lw.botMirror.conversations(n2)).toEqual([]);
    expect((await p1.api.getComputers({})).peers.find((p) => p.nodeId === wn)?.shareOnwardNodeIds).toEqual([]);
    expect(await failure(raw({ targetNodeId: n2, originNodeId: "", relayHops: 0 }))).toContain("direct partners");
  }, 15000);
});

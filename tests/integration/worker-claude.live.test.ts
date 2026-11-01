/**
 * Live, end to end below the gateway, for Claude: a (test) gateway configures a real worker host over gRPC,
 * creates a Claude thread in ASK mode, runs turns (permission round trips, resume), forks it at a turn and
 * answers an agent bus call. Opt-in: OA_LIVE=1 with the CLIProxyAPI env (docs/claude-adapter.md).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceLogin, InteractionKind, PermissionMode, Provider, ProviderProfileKind, type ThreadEvent } from "@open-agents/contracts";
import { journalHello } from "@open-agents/worker/gateway-link";
import { Journal } from "@open-agents/worker/journal";
import { serveLink, WorkerHost } from "@open-agents/worker/runtime";
import { ManagedRuntime } from "effect";
import { connectWorker, startGateway } from "./helpers.ts";

const LIVE = process.env["OA_LIVE"] === "1";
const proxyUrl = process.env["OA_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["OA_LIVE_CLIPROXYAPI_KEY"];
const model = process.env["OA_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5";

const text = (events: ThreadEvent[], turnId: string) =>
  events
    .filter((e) => e.turnId === turnId && e.body.case === "itemCompleted" && e.body.value.item?.content.case === "agentMessage")
    .map((e) => (e.body.case === "itemCompleted" && e.body.value.item?.content.case === "agentMessage" ? e.body.value.item.content.value.text : ""))
    .join("\n");

describe.skipIf(!LIVE || !proxyUrl || !proxyKey)("worker + Claude end to end (live)", () => {
  const dir = mkdtempSync(join(tmpdir(), "oa-e2e-claude-"));
  const repo = mkdtempSync(join(tmpdir(), "oa-e2e-claude-repo-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  test("ASK turn with permissions, resume, fork at a turn, agent bus call, native subagents off", async () => {
    const gateway = await startGateway();
    const runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));
    const host = new WorkerHost({ runtime, dataDir: join(dir, "data"), clientVersion: "live" });
    const link = await connectWorker(gateway.server.url, { hello: { workerId: "worker-1", ...(await runtime.runPromise(journalHello())) } });
    const serving = serveLink(link, host, runtime);
    const connection = await gateway.nextConnection();

    const events: ThreadEvent[] = [];
    const permissions: string[] = [];
    const busCalls: { tool: string; threadId: string; turnId: string }[] = [];
    const busItemIds: string[] = [];
    let applied = false;
    void (async () => {
      for await (const message of connection.messages) {
        const payload = message.payload;
        if (payload.case === "configApplied") applied = payload.value.applied;
        if (payload.case === "threadEvent") {
          events.push(payload.value);
          connection.send({ case: "eventAck", value: { threadId: payload.value.threadId, ackSeq: payload.value.journalSeq } });
        }
        if (payload.case === "interactionRequest") {
          permissions.push(`${InteractionKind[payload.value.kind]}:${payload.value.toolName}`);
          connection.send({ case: "interactionResponse", value: { requestId: payload.value.requestId, allow: true } });
        }
        if (payload.case === "agentToolCall") {
          busCalls.push({ tool: payload.value.toolName, threadId: payload.value.threadId, turnId: payload.value.turnId });
          busItemIds.push(payload.value.itemId);
          connection.send({ case: "agentToolResult", value: { callId: payload.value.callId, content: '{"threads":[]}', resultJson: '{"threads":[]}' } });
        }
      }
    })();

    connection.send({
      case: "config",
      value: {
        version: 1n,
        allowedRoots: [repo],
        codex: { enabled: false },
        claude: { enabled: true, deviceLogin: DeviceLogin.NONE },
        profiles: [{ id: "live", kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: proxyUrl!, apiKey: proxyKey! }],
      },
    });
    while (!applied) await Bun.sleep(50);

    const turn = async (spec: object, turnId: string, prompt: string) => {
      const started = await connection.sendCommand({ case: "startTurn", value: { thread: spec, turnId, input: { text: prompt } } }, 60_000);
      expect(started).toMatchObject({ ok: true });
      const deadline = Date.now() + 240_000;
      while (!events.some((e) => e.turnId === turnId && e.body.case === "turnFinished") && Date.now() < deadline) await Bun.sleep(100);
      const finished = events.find((e) => e.turnId === turnId && e.body.case === "turnFinished");
      return finished?.body.case === "turnFinished" ? finished.body.value : undefined;
    };

    const threadId = Bun.randomUUIDv7();
    const spec = { threadId, provider: Provider.CLAUDE, providerProfileId: "live", cwd: repo, model, permissionMode: PermissionMode.ASK, enableAgentBus: true };
    expect(await connection.sendCommand({ case: "createThread", value: { thread: spec } }, 60_000)).toMatchObject({ ok: true });
    // The session id is the platform's: ready without a model call.
    const ready = events.find((e) => e.threadId === threadId && e.body.case === "threadReady");
    expect(ready?.body.case === "threadReady" && ready.body.value.providerThreadId).toBe(threadId);
    const withSession = { ...spec, providerThreadId: threadId };

    const first = await turn(withSession, "turn-1", "Create a file named hello.txt containing exactly: hi\nThen run `cat hello.txt` with Bash. Reply with the single word DONE.");
    expect(first?.outcome).toBe(1); // COMPLETED
    expect(await Bun.file(join(repo, "hello.txt")).text()).toContain("hi");
    expect(permissions.length).toBeGreaterThan(0); // ASK: the write and the command were approved through the gateway
    expect(permissions.every((p) => p.startsWith("PERMISSION:"))).toBe(true);
    const init = events.map((e) => JSON.parse(e.rawJson || "{}") as { type?: string; subtype?: string; tools?: string[] }).find((m) => m.type === "system" && m.subtype === "init");
    expect(init?.tools).toContain("mcp__openagents__spawn_thread");
    for (const native of ["Agent", "Task", "CronCreate", "ScheduleWakeup", "SendMessage"]) expect(init?.tools ?? []).not.toContain(native);

    const second = await turn(withSession, "turn-2", "Call the list_threads tool once, then tell me which file you created earlier. Answer with the file name.");
    expect(second?.outcome).toBe(1);
    expect(text(events, "turn-2")).toContain("hello.txt");
    expect(busCalls).toEqual([{ tool: "list_threads", threadId, turnId: "turn-2" }]);
    // The call is tied to its tool_use (stable call_id across re-sends) and shown as an agent_bus_call item.
    const busItem = events.find((e) => e.body.case === "itemStarted" && e.body.value.item?.content.case === "agentBusCall");
    expect(busItem?.body.case === "itemStarted" && busItem.body.value.item?.itemId).toBe(busItemIds[0]!);

    // Fork after turn 1: the copy knows the file, gets its own session.
    const forkId = Bun.randomUUIDv7();
    const forkSpec = { ...spec, threadId: forkId, depth: 1 };
    const forked = await connection.sendCommand(
      { case: "createThread", value: { thread: forkSpec, fork: { sourceThreadId: threadId, sourceProviderThreadId: threadId, afterTurnId: "turn-1", afterProviderTurnRef: first?.providerTurnRef ?? "" } } },
      60_000,
    );
    expect(forked).toMatchObject({ ok: true });
    const forkReady = events.find((e) => e.threadId === forkId && e.body.case === "threadReady");
    const forkSession = forkReady?.body.case === "threadReady" ? forkReady.body.value.providerThreadId : "";
    expect(forkSession).not.toBe(threadId);
    const third = await turn({ ...forkSpec, providerThreadId: forkSession }, "turn-3", "Which file did you create earlier? Answer with the file name only.");
    expect(third?.outcome).toBe(1);
    expect(text(events, "turn-3")).toContain("hello.txt");

    link.close();
    await serving;
    await host.close();
    await runtime.dispose();
    await gateway.link.shutdown();
    await gateway.server.close();
  }, 600_000);
});

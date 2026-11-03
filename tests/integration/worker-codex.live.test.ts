/**
 * Live, end to end below the gateway: a (test) gateway configures a real worker host over gRPC,
 * creates a Codex thread in ASK mode and starts a turn; Codex asks for permission, the gateway
 * allows it, the file appears and the transcript flows back as journaled ThreadEvents.
 * Opt-in: CANOPY_LIVE=1 with the CLIProxyAPI env (docs/codex-adapter.md).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DeviceLogin, InteractionKind, PermissionMode, Provider, ProviderProfileKind, type ThreadEvent } from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { journalHello } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { connectWorker, startGateway } from "./helpers.ts";

const LIVE = process.env["CANOPY_LIVE"] === "1";
const proxyUrl = process.env["CANOPY_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["CANOPY_LIVE_CLIPROXYAPI_KEY"];
const model = process.env["CANOPY_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol";

describe.skipIf(!LIVE || !proxyUrl || !proxyKey)("worker + Codex end to end (live)", () => {
  const dir = tempDir("oa-e2e-");
  const repo = tempDir("oa-e2e-repo-");

  test("ASK mode: permission round trip through the gateway, file written, transcript delivered", async () => {
    const gateway = await startGateway();
    const runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));
    const host = new WorkerHost({ runtime, dataDir: join(dir, "data"), clientVersion: "live" });
    const link = await connectWorker(gateway.server.url, { hello: { workerId: "worker-1", ...(await runtime.runPromise(journalHello())) } });
    const serving = serveLink(link, host, runtime);
    const connection = await gateway.nextConnection();

    const events: ThreadEvent[] = [];
    const permissions: string[] = [];
    let applied = false;
    void (async () => {
      for await (const message of connection.messages) {
        if (message.payload.case === "configApplied") applied = message.payload.value.applied;
        if (message.payload.case === "threadEvent") {
          events.push(message.payload.value);
          connection.send({ case: "eventAck", value: { threadId: message.payload.value.threadId, ackSeq: message.payload.value.journalSeq } });
        }
        if (message.payload.case === "interactionRequest") {
          const request = message.payload.value;
          permissions.push(`${InteractionKind[request.kind]}:${request.toolName}`);
          connection.send({ case: "interactionResponse", value: { requestId: request.requestId, allow: true } });
        }
      }
    })();

    connection.send({
      case: "config",
      value: {
        version: 1n,
        allowedRoots: [repo],
        codex: { enabled: true, deviceLogin: DeviceLogin.NONE },
        claude: { enabled: false },
        profiles: [{ id: "live", kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: proxyUrl!, apiKey: proxyKey! }],
      },
    });
    while (!applied) await Bun.sleep(50);

    const spec = { threadId: Bun.randomUUIDv7(), provider: Provider.CODEX, providerProfileId: "live", cwd: repo, model, permissionMode: PermissionMode.ASK };
    const created = await connection.sendCommand({ case: "createThread", value: { thread: spec } }, 60_000);
    expect(created).toMatchObject({ ok: true });
    const providerThreadId = events.find((e) => e.body.case === "threadReady" && e.threadId === spec.threadId);
    expect(providerThreadId).toBeDefined();

    const started = await connection.sendCommand(
      {
        case: "startTurn",
        value: {
          thread: spec,
          turnId: "turn-1",
          input: { text: "Create a file named hello.txt containing exactly: hi\nUse a shell command. Then reply with the single word DONE." },
        },
      },
      60_000,
    );
    expect(started).toMatchObject({ ok: true });
    const deadline = Date.now() + 240_000;
    while (!events.some((e) => e.turnId === "turn-1" && e.body.case === "turnFinished") && Date.now() < deadline) await Bun.sleep(100);

    expect(permissions.length).toBeGreaterThan(0); // read-only sandbox: the write had to be approved
    expect(permissions.every((p) => p.startsWith("PERMISSION:"))).toBe(true);
    expect(await Bun.file(join(repo, "hello.txt")).text()).toContain("hi");
    const finished = events.find((e) => e.turnId === "turn-1" && e.body.case === "turnFinished");
    expect(finished).toBeDefined();
    expect(events.every((e) => e.threadId === spec.threadId)).toBe(true);

    link.close();
    await serving;
    await host.close();
    await runtime.dispose();
    await gateway.link.shutdown();
    await gateway.server.close();
  }, 300_000);
});

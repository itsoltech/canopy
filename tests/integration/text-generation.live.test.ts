import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Provider, CommandSchema } from "@open-agents/contracts";
import { create } from "@bufbuild/protobuf";
import { dockerAvailable } from "@open-agents/db/testing";
import { GatewayStore } from "@open-agents/gateway/store";
import { tempDirs } from "@open-agents/testing";
import { journalHello, openGatewayLink } from "@open-agents/worker/gateway-link";
import { Journal } from "@open-agents/worker/journal";
import { serveLink, WorkerHost } from "@open-agents/worker/runtime";
import { ManagedRuntime } from "effect";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";
import { liveProxyReady, useLiveProxy } from "./support/live.ts";

const tempDir = tempDirs();
const proxyUrl = process.env["OA_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["OA_LIVE_CLIPROXYAPI_KEY"];

describe.skipIf(process.env["OA_LIVE"] !== "1" || !proxyUrl || !proxyKey || !dockerAvailable)("one-shot text through both live harness SDKs", () => {
  let gw: TestGateway;
  let workerId = "";
  let host: WorkerHost;
  let runtime: ManagedRuntime.ManagedRuntime<Journal, unknown>;
  let stop = async () => {};
  const dir = tempDir("oa-text-live-");
  const repo = tempDir("oa-text-live-repo-");
  beforeAll(async () => {
    gw = await startTestGateway();
    const worker = await gw.runtime.runPromise(GatewayStore.use((s) => s.addWorker({ ownerUserId: gw.userId, name: "generation" })));
    workerId = worker.workerId;
    await useLiveProxy(gw, workerId, { url: proxyUrl!, key: proxyKey!, allowedRoots: [repo] });
    runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));
    host = new WorkerHost({ runtime, dataDir: join(dir, "data"), clientVersion: "live" });
    const link = await openGatewayLink({ baseUrl: gw.grpcUrl, credential: worker.credential, hello: { workerId, ...(await runtime.runPromise(journalHello())) } });
    const serving = serveLink(link, host, runtime);
    stop = async () => { link.close(); await serving; await host.close(); await runtime.dispose(); };
    await liveProxyReady(gw, workerId);
  }, 120_000);
  afterAll(async () => { await stop(); await gw?.close(); });

  for (const c of [
    { provider: Provider.CLAUDE, name: "Claude", model: process.env["OA_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5" },
    { provider: Provider.CODEX, name: "Codex", model: process.env["OA_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol" },
  ]) {
    test(`${c.name}: returns plain text without platform threads, turns, journal records or transcripts`, async () => {
      const before = await runtime.runPromise(journalHello());
      const connection = gw.core.link.connections.get(workerId)!;
      const request = { provider: c.provider, profileId: "cliproxyapi", model: c.model, effort: "low", prompt: "Generate a short Polish title for this task: naprawić logowanie. Return only the title." };
      const result = await connection.sendCommand({ case: "generateText", value: request }, 35_000);
      expect(result).toMatchObject({ ok: true });
      expect(result.generatedText.trim().length).toBeGreaterThan(2);
      const denied = await connection.sendCommand({ case: "generateText", value: { ...request,
        prompt: "Run ls on your own filesystem using your shell tool. If no shell tool is available, reply exactly NO_LOCAL_TOOLS. Do not describe a command for the user to run.",
      } }, 35_000);
      expect(denied.ok).toBe(true);
      expect(denied.generatedText).toContain("NO_LOCAL_TOOLS");
      expect(host.runningTurns()).toEqual([]);
      expect(await runtime.runPromise(journalHello())).toEqual(before);
      expect((await gw.api.listThreads({})).threads).toHaveLength(0);
      const projects = join(dir, "data", "claude-home", "projects");
      const transcripts = existsSync(projects) ? readdirSync(projects, { recursive: true }).filter((p) => String(p).endsWith(".jsonl")) : [];
      expect(transcripts).toEqual([]);
      const scratch = join(dir, "data", "text-generation");
      expect(existsSync(scratch) ? readdirSync(scratch) : []).toEqual([]);

      // Read-only queries never record prompt/result (or an error) in the command journal.
      const commandId = Bun.randomUUIDv7();
      const invalid = await host.handleCommand(create(CommandSchema, { commandId, kind: { case: "generateText", value: { ...request, prompt: "" } } }));
      expect(invalid?.ok).toBe(false);
      expect(await runtime.runPromise(Journal.use((j) => j.commandResult(commandId)))).toBeUndefined();
    }, 45_000);
  }
});

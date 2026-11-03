/** Live request_secret on both harnesses through CLIProxyAPI; only a SHA-256 enters context. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PermissionMode, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDirs } from "@canopy/testing";
import { journalHello, openGatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { liveProxyReady, useLiveProxy } from "./support/live.ts";

const tempDir = tempDirs();
const proxyUrl = process.env["CANOPY_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["CANOPY_LIVE_CLIPROXYAPI_KEY"];
const enabled = process.env["CANOPY_LIVE"] === "1" && !!proxyUrl && !!proxyKey && dockerAvailable;

describe.skipIf(!enabled)("thread secrets (Codex + Claude, live CLIProxyAPI)", () => {
  let gw: TestGateway;
  let stop = async () => {};
  let workspaceId = "";
  let projectId = "";
  let data = "";
  const logs: string[] = [];
  const query = <A extends object>(text: string, ...params: unknown[]) => gw.runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.unsafe<A>(text, params as never[]);
  }));
  beforeAll(async () => {
    gw = await startTestGateway();
    const repo = tempDir("oa-secret-live-repo-");
    data = tempDir("oa-secret-live-data-");
    const added = await gw.runtime.runPromise(GatewayStore.use((s) => s.addWorker({ name: "secret-live", ownerUserId: gw.userId })));
    await useLiveProxy(gw, added.workerId, { url: proxyUrl!, key: proxyKey!, allowedRoots: [repo] });
    const runtime = ManagedRuntime.make(Journal.layer(join(data, "journal.db")));
    const host = new WorkerHost({ runtime, dataDir: data, clientVersion: "live-secret", log: (message) => logs.push(message) });
    const link = await openGatewayLink({ baseUrl: gw.grpcUrl, credential: added.credential,
      hello: { workerId: added.workerId, capabilities: ["thread_secrets"], ...(await runtime.runPromise(journalHello())) } });
    const serving = serveLink(link, host, runtime, (message) => logs.push(message));
    stop = async () => { link.close(); await serving; await host.close(); await runtime.dispose(); };
    projectId = (await gw.api.createProject({ name: "Live secrets" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: added.workerId, rootPath: repo })).workspace!.id;
    await liveProxyReady(gw, added.workerId);
  }, 180_000);
  afterAll(async () => { await stop(); await gw?.close(); });

  for (const provider of [Provider.CODEX, Provider.CLAUDE]) for (const mode of [PermissionMode.ASK, PermissionMode.FULL_AUTO]) {
    test(`${Provider[provider]} ${PermissionMode[mode]} asks privately and proves file access with SHA-256 without exposing the value`, async () => {
      const value = `live-secret-${crypto.randomUUID()}-${crypto.randomUUID()}`;
      const hash = createHash("sha256").update(value).digest("hex");
      const thread = (await gw.api.createThread({ projectId, workspaceId, provider, providerProfileId: "cliproxyapi",
        model: provider === Provider.CODEX ? process.env["CANOPY_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol" : process.env["CANOPY_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5",
        permissionMode: mode, title: `Private secret ${Provider[provider]}`,
        initialMessage: "Call the platform request_secret tool NOW with label 'Development access token', description 'Verify private file access using SHA-256.', placeholder 'pat-…', name 'DEV_TOKEN'. " +
          "Do not ask in chat. Wait for the result. If pending, renew using request_id. After saved, run sha256sum on the returned private file path (this prints only its hash and path). " +
          `The expected SHA-256 is ${hash}. Compare it and reply exactly SECRET_HASH_MATCH if equal, otherwise SECRET_HASH_MISMATCH. ` +
          "Never print the file contents, never use Read/cat as a standalone tool, never include the value in any command or response.",
      })).thread!;
      const request = await eventually(() => query<{ id: string; status: string }>("SELECT id, status FROM thread_secrets WHERE thread_id = $1::uuid ORDER BY created_at", thread.id), (rows) => rows[0]?.status === "pending", 180_000);
      await gw.api.answerThreadSecret({ requestId: request[0]!.id, value });
      const done = await eventually(async () => {
        // ASK keeps the usual shell approval. Only this test's hash command is approved.
        const permissions = await query<{ id: string; request: unknown }>("SELECT id, request FROM interaction_requests WHERE thread_id = $1::uuid AND status = 'pending' AND kind = 'permission'", thread.id);
        for (const permission of permissions) {
          const text = JSON.stringify(permission.request);
          if (text.includes("sha256sum") && !text.includes(value)) await gw.api.answerInteraction({ requestId: permission.id, allow: true });
        }
        return (await gw.api.getThread({ threadId: thread.id })).thread;
      }, (t) => t?.lastTurnStatus === "completed" || t?.lastTurnStatus === "failed", 240_000);
      expect(done?.lastTurnStatus).toBe("completed");
      const messages = await query<{ text: string }>("SELECT content->'agentMessage'->>'text' AS text FROM thread_items WHERE thread_id = $1::uuid AND type = 'agent_message' ORDER BY first_seq DESC", thread.id);
      expect(messages[0]?.text.trim()).toBe("SECRET_HASH_MATCH");
      const calls = await query<{ result: unknown }>("SELECT result FROM agent_bus_calls WHERE source_thread_id = $1::uuid AND tool = 'request_secret'", thread.id);
      expect(JSON.stringify(calls)).not.toContain(value);
      expect(JSON.stringify(calls)).toContain("thread-secrets");
      for (const table of ["turns", "thread_items", "thread_events", "agent_bus_calls", "worker_commands", "interaction_requests"]) {
        const rows = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} r WHERE row_to_json(r)::text LIKE $1`, `%${value}%`);
        expect(rows[0]?.n, table).toBe(0);
      }
      expect(logs.join("\n")).not.toContain(value);
      for (const file of readdirSync(data, { recursive: true }).filter((f) => typeof f === "string" && f.endsWith(".jsonl"))) {
        expect(readFileSync(join(data, String(file)), "utf8").includes(value), String(file)).toBe(false);
      }
      await gw.api.revokeThreadSecret({ requestId: request[0]!.id });
    }, 480_000);
  }
});

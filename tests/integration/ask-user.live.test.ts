/** Real harnesses through CLIProxyAPI; answers use the same API as the UI. No credentials or raw SDK configuration are logged. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
const LIVE = process.env["OA_LIVE"] === "1";
const proxyUrl = process.env["OA_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["OA_LIVE_CLIPROXYAPI_KEY"];
const CASES = [
  { name: "Codex", provider: Provider.CODEX, model: process.env["OA_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol" },
  { name: "Claude", provider: Provider.CLAUDE, model: process.env["OA_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5" },
] as const;

describe.skipIf(!LIVE || !proxyUrl || !proxyKey || !dockerAvailable)("platform questions with real harnesses (live)", () => {
  let gw: TestGateway;
  let projectId = "";
  let workspaceId = "";
  let workerId = "";
  let stop = async () => {};
  const query = <A extends object>(text: string, ...params: unknown[]) => gw.runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.unsafe<A>(text, params as never[]);
  }));
  const messages = (id: string) => query<{ text: string }>("SELECT content->'agentMessage'->>'text' AS text FROM thread_items WHERE thread_id = $1::uuid AND type = 'agent_message'", id);
  beforeAll(async () => {
    gw = await startTestGateway();
    const cwd = tempDir("oa-questions-live-repo-");
    const data = tempDir("oa-questions-live-worker-");
    const added = await gw.runtime.runPromise(GatewayStore.use((s) => s.addWorker({ name: "Questions live", ownerUserId: gw.userId })));
    workerId = added.workerId;
    await useLiveProxy(gw, workerId, { url: proxyUrl!, key: proxyKey!, allowedRoots: [cwd] });
    const runtime = ManagedRuntime.make(Journal.layer(join(data, "journal.db")));
    const host = new WorkerHost({ runtime, dataDir: join(data, "data"), clientVersion: "ask-user-live" });
    const link = await openGatewayLink({ baseUrl: gw.grpcUrl, credential: added.credential, hello: { workerId, ...(await runtime.runPromise(journalHello())) } });
    const serving = serveLink(link, host, runtime);
    stop = async () => { link.close(); await serving; await host.close(); await runtime.dispose(); };
    await liveProxyReady(gw, workerId);
    projectId = (await gw.api.createProject({ name: "Questions live" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId, rootPath: cwd, label: "live" })).workspace!.id;
  }, 120_000);
  afterAll(async () => { await stop(); await gw?.close(); });

  for (const c of CASES) for (const wait of [true, false]) {
    test(`${c.name}: ${wait ? "sync waits and uses the API answer" : "async answer steers into the running turn"}`, async () => {
      const thread = (await gw.api.createThread({
        projectId, workspaceId, title: `${c.name} ${wait ? "sync" : "async"}`, provider: c.provider, providerProfileId: "cliproxyapi", model: c.model,
        permissionMode: PermissionMode.FULL_AUTO,
        initialMessage: `Test the platform ask_user tool. Call it exactly once with wait=${wait}, questions=[{"id":"color","header":"Color","question":"Which color should I use?","kind":"single_choice","options":[{"label":"Blue"},{"label":"Green"}],"recommended":"Blue"}]. ` +
          (wait ? "Wait for the answer. If pending, call get_answers with wait=true again until answered. Do no other work while waiting. " : "Then run the shell command `sleep 6` while the user answers. Read the incoming answer, or check get_answers if necessary. ") +
          "After receiving the answer, reply exactly RESULT: followed by the chosen color. Do not guess. Use the platform tool, not a native question tool.",
      })).thread!;
      const requests = await eventually(() => query<{ id: string; question_wait: boolean; turn_id: string }>("SELECT id, question_wait, turn_id FROM interaction_requests WHERE thread_id = $1::uuid AND tool_name = 'ask_user'", thread.id), (r) => r.length === 1, 180_000);
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.question_wait).toBe(wait);
      expect((await messages(thread.id)).some((m) => /RESULT:/.test(m.text ?? ""))).toBe(false);
      if (wait && c.provider === Provider.CODEX && process.env["OA_ASK_LONG_WAIT"] === "1") {
        // Cross the shared 120 s boundary: the model must renew the wait without asking again.
        await Bun.sleep(123_000);
        expect((await messages(thread.id)).some((m) => /RESULT:/.test(m.text ?? ""))).toBe(false);
      }
      await gw.api.answerInteraction({ requestId: request.id, answerJson: JSON.stringify({ answers: [{ id: "color", kind: "choice", labels: ["Green"] }] }) });
      const answered = await eventually(() => messages(thread.id), (r) => r.some((m) => /RESULT:\s*Green/i.test(m.text ?? "")), 180_000);
      expect(answered.some((m) => /RESULT:\s*Green/i.test(m.text ?? ""))).toBe(true);
      if (wait && c.provider === Provider.CODEX && process.env["OA_ASK_LONG_WAIT"] === "1") {
        expect((await query<{ n: number }>("SELECT count(*)::int AS n FROM agent_bus_calls WHERE source_thread_id = $1::uuid AND tool = 'get_answers'", thread.id))[0]?.n).toBeGreaterThan(0);
      }
      if (!wait) {
        const steers = await query<{ status: string; turn_id: string; hops: number }>("SELECT status, turn_id, hops FROM turn_steers WHERE thread_id = $1::uuid", thread.id);
        expect(steers).toContainEqual({ status: "delivered", turn_id: request.turn_id, hops: 1 });
      }
      expect(await query<{ n: number }>("SELECT count(*)::int AS n FROM interaction_requests WHERE thread_id = $1::uuid", thread.id)).toEqual([{ n: 1 }]);
      await eventually(() => query<{ n: number }>("SELECT count(*)::int AS n FROM turns WHERE thread_id = $1::uuid AND status IN ('running', 'queued')", thread.id), (r) => r[0]?.n === 0, 180_000);
      console.info(`${c.name} ${wait ? "sync" : "async"}: API answer used${wait ? "" : ", steer delivered"}`);
    }, 600_000);
  }
});

/**
 * Live, through the whole stack (docs/agent-bus.md): subagents on another provider and a message to another thread.
 * - a Codex main thread asked for a Claude subagent starts one with spawn_thread (provider claude/cliproxyapi), the
 *   child runs on Claude, does a small task, and its result comes back to the Codex parent; the same the other way
 *   round (Claude parent, Codex child),
 * - a thread asked to message another, unrelated thread (another tree) finds it and sends with send_message: the
 *   target runs it as a turn marked as an agent's, and the reply comes back to the sender.
 * Opt-in: OA_LIVE=1 with the CLIProxyAPI env (docs/codex-adapter.md#testy-na-żywo).
 */
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
const CODEX_MODEL = process.env["OA_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol";
const CLAUDE_MODEL = process.env["OA_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5";

const CASES = [
  { name: "Codex parent, Claude child", parent: Provider.CODEX, parentModel: CODEX_MODEL, child: Provider.CLAUDE, childKey: "claude/cliproxyapi", childModel: CLAUDE_MODEL, question: "17 * 23", answer: "391" },
  { name: "Claude parent, Codex child", parent: Provider.CLAUDE, parentModel: CLAUDE_MODEL, child: Provider.CODEX, childKey: "codex/cliproxyapi", childModel: CODEX_MODEL, question: "19 * 21", answer: "399" },
] as const;

describe.skipIf(!LIVE || !proxyUrl || !proxyKey || !dockerAvailable)("subagents on any provider and messages between threads (live)", () => {
  let gw: TestGateway;
  let workerId = "";
  let workspaceId = "";
  let projectId = "";
  let stop = async () => {};
  const query = <A extends object>(text: string, ...params: unknown[]) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<A>(text, params as never[]);
      }),
    );
  const agentText = (threadId: string) =>
    query<{ text: string }>(
      "SELECT content->'agentMessage'->>'text' AS text FROM thread_items WHERE thread_id = $1::uuid AND type = 'agent_message' ORDER BY first_seq",
      threadId,
    );
  /** Nothing queued or running in these trees any more (notification turns included). */
  const settle = (rootIds: string[]) =>
    eventually(
      () => query<{ n: number }>(
        "SELECT count(*)::int AS n FROM turns u JOIN threads t ON t.id = u.thread_id WHERE t.root_thread_id = ANY($1::uuid[]) AND u.status IN ('queued', 'running')",
        `{${rootIds.join(",")}}`,
      ),
      (rows) => rows[0]?.n === 0,
      300_000,
    );

  beforeAll(async () => {
    gw = await startTestGateway();
    const repo = tempDir("oa-live-any-repo-");
    const data = tempDir("oa-live-any-worker-");
    const added = await gw.runtime.runPromise(GatewayStore.use((s) => s.addWorker({ name: "live", ownerUserId: gw.userId })));
    workerId = added.workerId;
    await useLiveProxy(gw, workerId, { url: proxyUrl!, key: proxyKey!, allowedRoots: [repo] });
    const runtime = ManagedRuntime.make(Journal.layer(join(data, "journal.db")));
    const host = new WorkerHost({ runtime, dataDir: join(data, "data"), clientVersion: "live" });
    const link = await openGatewayLink({ baseUrl: gw.grpcUrl, credential: added.credential, hello: { workerId, ...(await runtime.runPromise(journalHello())) } });
    const serving = serveLink(link, host, runtime);
    stop = async () => {
      link.close();
      await serving;
      await host.close();
      await runtime.dispose();
    };
    projectId = (await gw.api.createProject({ name: "Live any provider" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId, rootPath: repo, label: "live" })).workspace!.id;
    await liveProxyReady(gw, workerId);
    // Both catalogs must be in: the subagent's model is checked against the other provider's.
    await eventually(() => gw.api.listModels({ workerId }), (r) => (r.workers[0]?.profiles.filter((p) => p.profileId === "cliproxyapi").length ?? 0) >= 2, 90_000);
  }, 180_000);

  afterAll(async () => {
    await stop();
    await gw?.close();
  });

  for (const c of CASES) {
    test(`${c.name}: the subagent runs on the other provider and its result returns to the parent`, async () => {
      const main = (
        await gw.api.createThread({
          projectId,
          workspaceId,
          title: `${c.name}`,
          provider: c.parent,
          providerProfileId: "cliproxyapi",
          model: c.parentModel,
          permissionMode: PermissionMode.ASK,
          initialMessage:
            `Delegate this to a subagent running on the provider "${c.childKey}" with the model "${c.childModel}" ` +
            `(spawn_thread with provider and model; call list_agents first if you need to): ` +
            `'What is ${c.question}? Answer with the number only.' Wait for its result, then reply with 'RESULT: ' followed by the subagent's answer.`,
        })
      ).thread!;

      const spawn = await eventually(
        () => query<{ status: string; target_thread_id: string | null; error: string | null }>(
          "SELECT status, target_thread_id, error FROM agent_bus_calls WHERE source_thread_id = $1::uuid AND tool = 'spawn_thread' ORDER BY created_at",
          main.id,
        ),
        (rows) => rows.some((r) => r.status === "completed" && r.target_thread_id),
        300_000,
      );
      const childId = spawn.find((r) => r.status === "completed")!.target_thread_id!;
      const child = await eventually(
        async () => (await gw.api.getThread({ threadId: childId })).thread,
        (t) => t?.lastTurnStatus === "completed" && t.lastMessage.includes(c.answer),
        300_000,
      );
      expect([child!.provider, child!.providerProfileId, child!.model, child!.parentThreadId]).toEqual([c.child, "cliproxyapi", c.childModel, main.id]);

      const answers = await eventually(() => agentText(main.id), (rows) => rows.some((r) => new RegExp(`RESULT:\\s*${c.answer}`).test(r.text ?? "")), 300_000);
      expect(answers.length).toBeGreaterThan(0);
      await settle([main.id]);
      console.info(`${c.name}: ${child!.model} subagent ${childId} answered "${child!.lastMessage.trim()}"`);
    }, 900_000);
  }

  test("a thread messages another, unrelated thread: queued there as an agent's message, the reply comes back", async () => {
    const target = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        title: "Release notes desk",
        provider: Provider.CLAUDE,
        providerProfileId: "cliproxyapi",
        model: CLAUDE_MODEL,
        permissionMode: PermissionMode.ASK,
        initialMessage: "Reply with OK.",
      })
    ).thread!;
    await settle([target.id]);
    const sender = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        title: "Coordinator",
        provider: Provider.CODEX,
        providerProfileId: "cliproxyapi",
        model: CODEX_MODEL,
        permissionMode: PermissionMode.ASK,
        initialMessage:
          "Find my thread titled 'Release notes desk' (list_threads with scope all) and send it this message with send_message: " +
          "'What is 12 + 30? Answer with the number only.' When its answer comes back to you, reply with 'GOT: ' followed by it.",
      })
    ).thread!;

    const sent = await eventually(
      () => query<{ status: string; target_thread_id: string | null }>(
        "SELECT status, target_thread_id FROM agent_bus_calls WHERE source_thread_id = $1::uuid AND tool = 'send_message' ORDER BY created_at",
        sender.id,
      ),
      (rows) => rows.some((r) => r.status === "completed" && r.target_thread_id === target.id),
      300_000,
    );
    expect(sent.length).toBeGreaterThan(0);
    // The target ran it as a turn from an agent (sender: the Codex coordinator) and answered.
    const turn = await eventually(
      async () => (await query<{ id: string; status: string; hops: number }>(
        "SELECT u.id, u.status, u.hops FROM turns u JOIN turn_sources s ON s.turn_id = u.id WHERE u.thread_id = $1::uuid AND s.source_kind = 'message' AND s.source_thread_id = $2::uuid",
        target.id,
        sender.id,
      ))[0],
      (row) => row?.status === "completed",
      300_000,
    );
    expect(turn?.hops).toBe(1);
    const senderOf = await query<{ source_provider: string; source_title: string }>("SELECT source_provider, source_title FROM turn_sources WHERE turn_id = $1::uuid", turn!.id);
    expect(senderOf[0]).toEqual({ source_provider: "codex", source_title: "Coordinator" });
    await eventually(() => agentText(sender.id), (rows) => rows.some((r) => /GOT:\s*42/.test(r.text ?? "")), 300_000);
    await settle([sender.id, target.id]);
  }, 900_000);
});

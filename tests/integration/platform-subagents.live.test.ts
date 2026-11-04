/**
 * Live, through the whole stack: platform subagents. A main thread on Codex (a multi-agent v2 model) and on
 * Claude is asked to delegate a small task to a subagent and to wait for its result. The harnesses' own
 * subagent tools are off (Codex: none of spawn_agent/wait_agent/... in the rollout's tool list; Claude: no
 * Agent/Task call), the model uses the bus tool spawn_thread, the child is a side thread of the main thread
 * the UI sees, and its result reaches the parent.
 * Opt-in: CANOPY_LIVE=1 with the CLIProxyAPI env (docs/codex-adapter.md#testy-na-żywo).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PermissionMode, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDirs } from "@canopy/testing";
import { journalHello, openGatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { useLiveProxy } from "./support/live.ts";

const tempDir = tempDirs();

const LIVE = process.env["CANOPY_LIVE"] === "1";
const proxyUrl = process.env["CANOPY_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["CANOPY_LIVE_CLIPROXYAPI_KEY"];

const CASES = [
  { name: "Codex", provider: Provider.CODEX, model: process.env["CANOPY_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol" },
  { name: "Claude", provider: Provider.CLAUDE, model: process.env["CANOPY_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5" },
] as const;

/**
 * A declaration of one of Codex's collaboration tools (function, code-mode section or signature), not a mention in a
 * description. Its send_message is left out: the bus has a tool of that name.
 */
const CODEX_COLLAB =
  /("name":"|### `|\b)(spawn_agent|wait_agent|send_input|followup_task|interrupt_agent|close_agent|resume_agent)("|`|\(args)/;

function rollouts(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile() && f.name.startsWith("rollout-") && f.name.endsWith(".jsonl"))
    .map((f) => join(f.parentPath, f.name));
}

describe.skipIf(!LIVE || !proxyUrl || !proxyKey || !dockerAvailable)(
  "platform subagents with a real worker (live)",
  () => {
    let gw: TestGateway;
    let workerId = "";
    let workspaceId = "";
    let projectId = "";
    let dataDir = "";
    let stop = async () => {};

    const query = <A extends object>(text: string, ...params: unknown[]) =>
      gw.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return yield* sql.unsafe<A>(text, params as never[]);
        }),
      );

    beforeAll(async () => {
      gw = await startTestGateway();
      const repo = tempDir("canopy-live-ui-repo-");
      const data = tempDir("canopy-live-ui-worker-");
      dataDir = data;

      // A real worker with both providers through the proxy (its key is a secret reference, as with the CLI).
      const added = await gw.runtime.runPromise(
        GatewayStore.use((s) => s.addWorker({ name: "live", ownerUserId: gw.userId })),
      );

      workerId = added.workerId;
      await useLiveProxy(gw, workerId, { url: proxyUrl!, key: proxyKey!, allowedRoots: [repo] });
      const runtime = ManagedRuntime.make(Journal.layer(join(data, "journal.db")));
      const host = new WorkerHost({ runtime, dataDir: join(data, "data"), clientVersion: "live" });

      const link = await openGatewayLink({
        baseUrl: gw.grpcUrl,
        credential: added.credential,
        hello: { workerId, ...(await runtime.runPromise(journalHello())) },
      });

      const serving = serveLink(link, host, runtime);
      stop = async () => {
        link.close();
        await serving;
        await host.close();
        await runtime.dispose();
      };

      projectId = (await gw.api.createProject({ name: "Live subagents" })).project!.id;
      workspaceId = (await gw.api.createWorkspace({ projectId, workerId, rootPath: repo, label: "live" })).workspace!
        .id;
    }, 120_000);

    afterAll(async () => {
      await stop();
      await gw?.close();
    });

    for (const c of CASES) {
      test(`${c.name}: "use a subagent" starts a platform side thread with spawn_thread, and its result comes back`, async () => {
        // The catalog must be in before a model is chosen.
        await eventually(
          () => gw.api.listModels({ workerId }),
          (r) => (r.workers[0]?.profiles.length ?? 0) >= 2,
          90_000,
        );

        const main = (
          await gw.api.createThread({
            projectId,
            workspaceId,
            title: `${c.name} orchestrator`,
            provider: c.provider,
            providerProfileId: "cliproxyapi",
            model: c.model,
            permissionMode: PermissionMode.ASK,
            initialMessage:
              "Use a subagent for this: delegate the question 'What is 17 * 23? Answer with the number only.' to a subagent, " +
              "wait for its result, then reply with 'RESULT: ' followed by the subagent's answer.",
          })
        ).thread!;

        // The model started a platform subagent through the bus...
        const spawn = await eventually(
          () =>
            query<{ status: string; target_thread_id: string | null; error: string | null }>(
              "SELECT status, target_thread_id, error FROM agent_bus_calls WHERE source_thread_id = $1::uuid AND tool = 'spawn_thread' ORDER BY created_at",
              main.id,
            ),
          (rows) => rows.some((r) => r.status === "completed" && r.target_thread_id),
          300_000,
        );

        const childId = spawn.find((r) => r.status === "completed")!.target_thread_id!;

        // ...which the UI sees as a side thread of the main thread, with the subagent's answer.
        const child = await eventually(
          async () => (await gw.api.listThreads({ projectId })).threads.find((t) => t.id === childId),
          (t) => t?.status === "idle" && t.lastMessage.includes("391"),
          300_000,
        );

        expect([child!.kind, child!.parentThreadId, child!.spawnedByAgent, child!.model]).toEqual([
          ui.ThreadKind.SIDE,
          main.id,
          true,
          c.model,
        ]);

        // The parent got the result (wait_threads or the notification turn) and answered with it.
        const answers = await eventually(
          () =>
            query<{ text: string }>(
              "SELECT content->'agentMessage'->>'text' AS text FROM thread_items WHERE thread_id = $1::uuid AND type = 'agent_message' ORDER BY first_seq",
              main.id,
            ),
          (rows) => rows.some((r) => /RESULT:\s*391/.test(r.text ?? "")),
          300_000,
        );

        expect(answers.length).toBeGreaterThan(0);

        // No harness-native subagent anywhere.
        const items = await query<{ type: string; content: string }>(
          "SELECT i.type, i.content::text AS content FROM thread_items i JOIN threads t ON t.id = i.thread_id WHERE t.root_thread_id = $1::uuid",
          main.id,
        );

        expect(
          items.filter(
            (i) => i.type === "subagent" || /"(name|tool|toolName)":\s*"(Agent|Task|spawn_agent)"/.test(i.content),
          ),
        ).toEqual([]);

        if (c.provider === Provider.CODEX) {
          const toolLists = rollouts(dataDir).flatMap((file) =>
            readFileSync(file, "utf8")
              .split("\n")
              .filter((l) => l.includes('"additional_tools"')),
          );

          expect(toolLists.length).toBeGreaterThan(0);
          expect(toolLists.filter((l) => CODEX_COLLAB.test(l))).toEqual([]);
          expect(toolLists.every((l) => l.includes("spawn_thread"))).toBe(true);
        }

        // The parent may still run the notification turn for the child's result: let the tree settle before the
        // worker is stopped.
        await eventually(
          () =>
            query<{ n: number }>(
              "SELECT count(*)::int AS n FROM turns u JOIN threads t ON t.id = u.thread_id WHERE t.root_thread_id = $1::uuid AND u.status IN ('queued', 'running')",
              main.id,
            ),
          (rows) => rows[0]?.n === 0,
          300_000,
        );
        console.info(`${c.name}: subagent ${childId} answered "${child!.lastMessage.trim()}"`);
      }, 900_000);
    }
  },
);

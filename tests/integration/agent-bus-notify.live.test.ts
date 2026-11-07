/** Opt-in CLIProxyAPI regression: a real parent spawns with notify, waits, closes; no report turn after it. */
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
const proxyUrl = process.env["CANOPY_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["CANOPY_LIVE_CLIPROXYAPI_KEY"];
const model = process.env["CANOPY_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol";

describe.skipIf(process.env["CANOPY_LIVE"] !== "1" || !proxyUrl || !proxyKey || !dockerAvailable)(
  "agent bus notify and wait (live)",
  () => {
    let gw: TestGateway;
    let workerId: string;
    let projectId: string;
    let workspaceId: string;
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
      const repo = tempDir("canopy-live-notify-repo-");
      const data = tempDir("canopy-live-notify-worker-");

      const added = await gw.runtime.runPromise(
        GatewayStore.use((s) => s.addWorker({ name: "notify-live", ownerUserId: gw.userId })),
      );

      workerId = added.workerId;
      await useLiveProxy(gw, workerId, {
        url: proxyUrl!,
        key: proxyKey!,
        allowedRoots: [repo],
        harnesses: [Provider.CODEX],
      });
      const runtime = ManagedRuntime.make(Journal.layer(join(data, "journal.db")));
      const host = new WorkerHost({ runtime, dataDir: join(data, "data"), clientVersion: "live" });

      const link = await openGatewayLink({
        baseUrl: gw.grpcUrl,
        credential: added.credential,
        hello: { workerId, ...(await runtime.runPromise(journalHello())) },
      });

      const serving = serveLink(link, host, runtime);
      stop = async () => {
        await host.shutdown();
        link.close();
        await serving;
        await host.close();
        await runtime.dispose();
      };

      projectId = (await gw.api.createProject({ name: "Live notify" })).project!.id;
      workspaceId = (await gw.api.createWorkspace({ projectId, workerId, rootPath: repo, label: "live" })).workspace!
        .id;
      await liveProxyReady(gw, workerId, [Provider.CODEX]);
    }, 180_000);

    afterAll(async () => {
      await stop();
      await gw?.close();
    });

    test("Codex parent waits for a notified child result and ends with no extra turn", async () => {
      const parent = (
        await gw.api.createThread({
          projectId,
          workspaceId,
          provider: Provider.CODEX,
          providerProfileId: "cliproxyapi",
          model,
          title: "Notify wait regression",
          permissionMode: PermissionMode.ASK,
          initialMessage:
            "Perform exactly this tool sequence: (1) spawn_thread with notify=true, title='Notify child', " +
            "prompt='First use send_message with notify=false to your parent from the task note: CHECK: start checking the calculation now. " +
            "Then compute 17 * 23 and end with only the number; do not send the final result separately.' " +
            "(2) wait_threads for that child, until='all', timeout_seconds=120; " +
            "repeat wait_threads if needed until the child's final result is returned. " +
            "(3) close_thread for that child. (4) Reply 'RESULT: 391'. Keep your current turn running until these steps are done. " +
            "Do not use other tools. A platform report may also enter your running turn; still finish the wait and close steps.",
        })
      ).thread!;

      const ended = await eventually(
        () =>
          query<{ status: string }>("SELECT status FROM turns WHERE thread_id = $1::uuid ORDER BY ordinal", parent.id),
        (rows) => rows.length > 0 && rows.every((r) => r.status === "completed"),
        300_000,
      );

      expect(ended).toHaveLength(1);
      expect(ended[0]?.status).toBe("completed");

      const calls = await query<{
        tool: string;
        status: string;
        notify: boolean;
        notify_status: string | null;
        result: unknown;
      }>(
        "SELECT tool, status, notify, notify_status, result FROM agent_bus_calls WHERE source_thread_id = $1::uuid ORDER BY created_at",
        parent.id,
      );

      const tools = calls.filter((c) => c.status === "completed").map((c) => c.tool);
      expect(tools[0]).toBe("spawn_thread");
      expect(tools.slice(1, -1).every((tool) => tool === "wait_threads")).toBe(true);
      expect(tools.at(-1)).toBe("close_thread");
      expect(calls[0]?.notify).toBe(true);
      expect(["delivered", "consumed_by_wait"]).toContain(calls[0]?.notify_status ?? "");
      expect(calls.filter((call) => call.tool === "wait_threads").at(-1)?.result).toMatchObject({
        done: true,
        threads: [expect.objectContaining({ last_message: expect.stringContaining("391") })],
      });

      const messages = await query<{ message_consumed: string | null; entered: boolean }>(
        `SELECT c.message_consumed, EXISTS (SELECT 1 FROM turn_steers s WHERE s.agent_call_id = c.id AND s.status = 'delivered') AS entered
          FROM agent_bus_calls c WHERE c.target_thread_id = $1::uuid AND c.tool = 'send_message' AND c.status = 'completed'`,
        parent.id,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]?.entered || messages[0]?.message_consumed === "consumed_by_wait").toBe(true);
      await gw.core.sweep();

      const turns = await query<{ trigger: string; status: string }>(
        "SELECT trigger, status FROM turns WHERE thread_id = $1::uuid ORDER BY ordinal",
        parent.id,
      );

      expect(turns).toEqual([{ trigger: "user", status: "completed" }]);

      const answer = await query<{ text: string }>(
        "SELECT content->'agentMessage'->>'text' AS text FROM thread_items WHERE thread_id = $1::uuid AND type = 'agent_message' ORDER BY first_seq DESC LIMIT 1",
        parent.id,
      );

      expect(answer[0]?.text).toContain("RESULT: 391");
      console.info(
        `notify + wait live: parent ${parent.id}, one completed user turn, notification ${calls[0]?.notify_status}`,
      );
    }, 360_000);
  },
);

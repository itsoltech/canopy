/** A real Claude CLI, the worker and the gateway. All inference goes to the loopback test server. */
import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PermissionMode, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDirs } from "@canopy/testing";
import { journalHello, openGatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway } from "./support/gateway.ts";
import { liveProxyReady, useLiveProxy } from "./support/live.ts";

const tempDir = tempDirs();
const model = "claude-sonnet-4-6";
const prompt = "Run the project secret integration fixture.";
const name = "STAGING_TOKEN";

function modelReply(tool?: { id: string; name: string; input: Record<string, string> }) {
  const content = tool ? { type: "tool_use", id: tool.id, name: tool.name, input: {} } : { type: "text", text: "" };

  const delta = tool
    ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) }
    : { type: "text_delta", text: "Finished" };

  const message = {
    id: `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: null,
    usage: { input_tokens: 10, output_tokens: 0 },
  };

  const events = [
    { type: "message_start", message },
    { type: "content_block_start", index: 0, content_block: content },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  ];

  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function localModel(data: string, value: string) {
  const observed = { leaked: false, redacted: false, pathReturned: false, file: "" };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;

      if (path.endsWith("/models")) return Response.json({ data: [{ id: model, object: "model" }] });

      if (!path.endsWith("/messages")) return new Response(null, { status: 404 });
      const text = await request.text();
      observed.leaked ||= text.includes(value);

      if (!text.includes(prompt)) return modelReply();

      if (text.includes("toolu_fixture_read")) {
        observed.redacted = text.includes("[REDACTED]");

        return modelReply();
      }

      if (text.includes("toolu_fixture_request")) {
        const directory = join(data, "thread-secrets");

        const [file] = readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) =>
          entry.isFile(),
        );

        if (!file) return modelReply();
        observed.file = join(file.parentPath, file.name);
        observed.pathReturned = text.includes(observed.file);

        return modelReply({
          id: "toolu_fixture_read",
          name: "Bash",
          input: { command: `cat -- '${observed.file.replaceAll("'", "'\\''")}'`, description: "Read a test fixture" },
        });
      }

      return modelReply({
        id: "toolu_fixture_request",
        name: "mcp__canopy__request_secret",
        input: { project_secret: name },
      });
    },
  });

  return { server, observed };
}

test.skipIf(
  process.env["CANOPY_LIVE"] !== "1" || !dockerAvailable || !Bun.which("claude") || process.platform === "win32",
)(
  "project grant reaches the requesting CLI and its first Bash read is masked before inference",
  async () => {
    const gateway = await startTestGateway();
    const data = tempDir("canopy-project-grant-worker-");
    const workspace = tempDir("canopy-project-grant-repo-");
    const value = `synthetic-${crypto.randomUUID()}`;
    const { observed, server } = localModel(data, value);
    const runtime = ManagedRuntime.make(Journal.layer(join(data, "journal.db")));

    const host = new WorkerHost({
      runtime,
      dataDir: data,
      clientVersion: "test",
      deviceHomes: {
        claude: join(data, "claude-device"),
        grok: join(data, "grok-device"),
        codex: join(data, "codex-device"),
      },
    });

    let disconnect = async () => {};

    try {
      const worker = await gateway.addWorker("Project secrets");
      await useLiveProxy(gateway, worker.workerId, {
        url: server.url.href,
        key: "local-fixture",
        allowedRoots: [workspace],
        harnesses: [Provider.CLAUDE],
      });

      const link = await openGatewayLink({
        baseUrl: gateway.grpcUrl,
        credential: worker.credential,
        hello: {
          workerId: worker.workerId,
          capabilities: ["thread_secrets", "project_secret_leases_v1"],
          ...(await runtime.runPromise(journalHello())),
        },
      });

      const serving = serveLink(link, host, runtime);
      disconnect = async () => {
        link.close();
        await serving;
      };

      await liveProxyReady(gateway, worker.workerId, [Provider.CLAUDE]);
      const project = (await gateway.api.createProject({ name: "Secret filter" })).project!;

      const location = (
        await gateway.api.createWorkspace({ projectId: project.id, workerId: worker.workerId, rootPath: workspace })
      ).workspace!;

      await gateway.api.putProjectSecret({ projectId: project.id, name, value });

      const thread = (
        await gateway.api.createThread({
          projectId: project.id,
          workspaceId: location.id,
          provider: Provider.CLAUDE,
          providerProfileId: "cliproxyapi",
          model,
          title: "Secret filter",
          permissionMode: PermissionMode.ASK,
          initialMessage: prompt,
        })
      ).thread!;

      const finished = await eventually(
        async () => {
          if (observed.file) {
            const approvals = await gateway.runtime.runPromise(
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;

                return yield* sql<{ id: string; exposes_path: boolean }>`SELECT id,
                  strpos(request::text, ${observed.file}) > 0 AS exposes_path FROM interaction_requests
                  WHERE thread_id=${thread.id}::uuid AND kind='permission' AND status='pending'`;
              }),
            );

            for (const approval of approvals) {
              expect(approval.exposes_path).toBe(false);
              await gateway.api.answerInteraction({ requestId: approval.id, allow: true });
            }
          }

          return gateway.api.getThread({ threadId: thread.id });
        },
        (r) => ["completed", "failed", "interrupted"].includes(r.thread?.lastTurnStatus ?? ""),
        45_000,
      );

      if (finished.thread?.lastTurnStatus !== "completed") {
        const errors = await gateway.runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;

            return yield* sql<{ error: string | null }>`SELECT error FROM turns WHERE thread_id = ${thread.id}::uuid`;
          }),
        );

        throw new Error(
          `Secret fixture turn ${finished.thread?.lastTurnStatus}: ${errors.map((row) => row.error?.replaceAll(value, "[REDACTED]")).join(" ")}`,
        );
      }

      expect(observed.pathReturned).toBe(true);
      expect(observed.redacted).toBe(true);
      expect(observed.leaked).toBe(false);
      expect(
        await eventually(
          async () => existsSync(observed.file),
          (exists) => !exists,
        ),
      ).toBe(false);
    } finally {
      await disconnect();
      await host.close();
      await runtime.dispose();
      await server.stop(true);
      await gateway.close();
    }
  },
  120_000,
);

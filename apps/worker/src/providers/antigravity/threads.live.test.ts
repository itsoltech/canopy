import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  InteractionResponseSchema,
  PermissionMode,
  ThreadEventSchema,
  ThreadSpecSchema,
  TurnOutcome,
  UserInputSchema,
  type InteractionRequest,
  type ThreadEvent,
} from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import { tempDir } from "@canopy/testing";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { AntigravityThreads } from "./threads.ts";

const executable = process.env["CANOPY_ANTIGRAVITY_EXECUTABLE"] || Bun.which("agy");
const Live = process.env["CANOPY_LIVE"] === "1" && Boolean(executable);

const ModelRequest = Schema.Struct({
  tools: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        functionDeclarations: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
      }),
    ),
  ),
});

function fixtureModel() {
  let next: { name: string; args: JsonObject } | undefined;
  const available = new Set<string>();

  const upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const { tools } = Schema.decodeUnknownSync(ModelRequest)(await request.json());
      let operation: typeof next;

      if (tools?.length) {
        for (const tool of tools)
          for (const declaration of tool.functionDeclarations ?? []) available.add(declaration.name);
        operation = next;
        next = undefined;
      }

      const message = {
        candidates: [
          {
            content: { role: "model", parts: [operation ? { functionCall: operation } : { text: "Done" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 20,
          cachedContentTokenCount: 5,
          candidatesTokenCount: 2,
          thoughtsTokenCount: 3,
          totalTokenCount: 25,
        },
      };

      return new Response(`data: ${JSON.stringify(message)}\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });

  return {
    upstream,
    available,
    call(name: string, args: JsonObject) {
      available.clear();
      next = { name, args };
    },
  };
}

function installProjectCustomizations(cwd: string, serverUrl: string) {
  const dir = join(cwd, ".agents");
  mkdirSync(dir);

  const command =
    process.platform === "win32" ? 'echo ran > "%CANOPY_TEST_PROJECT_HOOK%"' : 'echo ran > "$CANOPY_TEST_PROJECT_HOOK"';

  const hook = { project: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command }] }] } };

  writeFileSync(join(dir, "hooks.json"), JSON.stringify(hook));
  writeFileSync(join(dir, "mcp_config.json"), JSON.stringify({ mcpServers: { project: { serverUrl } } }));
}

/** Exercise the installed CLI against local Gemini wire responses, including its real permission and persistence code. */
test.skipIf(!Live)(
  "Antigravity reloads the same conversation and enforces each turn's file permissions",
  async () => {
    const root = tempDir("canopy-antigravity-permissions-");
    const cwd = join(root, "workspace");
    mkdirSync(cwd);
    const model = fixtureModel();
    const projectHook = join(cwd, "project-hook-ran");
    let projectRequests = 0;

    const projectMcp = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        projectRequests++;

        return new Response(null, { status: 404 });
      },
    });

    const calls: string[] = [];
    const permissions: InteractionRequest[] = [];
    const events: ThreadEvent[] = [];

    const threads = new AntigravityThreads({
      dataDir: join(root, "worker"),
      executable: executable!,
      linkDeviceLogin: false,
      deviceHome: join(root, "device"),
      profile: () => ({
        id: "native",
        kind: "native",
        providers: ["antigravity"],
        runtime: {},
        env: {
          GEMINI_API_KEY: "synthetic-test-key",
          GOOGLE_GEMINI_BASE_URL: model.upstream.url.origin,
          CANOPY_TEST_PROJECT_HOOK: projectHook,
        },
      }),
      record: async (threadId, { $typeName: _typeName, ...init }) => {
        const event = create(ThreadEventSchema, { ...init, threadId });
        events.push(event);

        return event;
      },
      callTool: async (call) => {
        calls.push(call.toolName);

        return create(AgentToolResultSchema, { content: "[]" });
      },
      interact: async (request) => {
        permissions.push(request);

        return create(InteractionResponseSchema, { allow: false });
      },
    });

    const spec = create(ThreadSpecSchema, {
      threadId: "acl",
      cwd,
      enableAgentBus: true,
      permissionMode: PermissionMode.FULL_ACCESS,
    });

    const run = async (mode: PermissionMode, path?: string) => {
      permissions.length = 0;

      if (path) model.call("write_file", { Path: path, Content: "file fixture", Overwrite: true });
      else model.call("mcp_canopy_list_threads", { toolSummary: "List threads" });
      const turnId = crypto.randomUUID();
      await threads.startTurn(spec, turnId, create(UserInputSchema, { text: "Run the fixture edit." }), {
        model: "",
        effort: "",
        permissionMode: mode,
      });
      const end = events.findLast((event) => event.turnId === turnId && event.body.case === "turnFinished");

      if (end?.body.case !== "turnFinished") throw new Error("Missing turn completion");
      expect(end.body.value).toMatchObject({ outcome: TurnOutcome.COMPLETED, providerTurnRef: spec.providerThreadId });
      expect(end.body.value.usage?.cachedInputTokens).toBeGreaterThan(0n);
      expect(end.body.value.usage?.inputTokens).toBe(end.body.value.usage!.cachedInputTokens * 4n);
    };

    try {
      installProjectCustomizations(cwd, new URL("/mcp", projectMcp.url).href);
      spec.providerThreadId = await threads.create(spec);
      await expect(threads.create({ ...spec, threadId: "other-conversation" })).rejects.toThrow();
      const unrestricted = join(cwd, "unrestricted");
      await run(PermissionMode.FULL_ACCESS, unrestricted);
      expect(await Bun.file(unrestricted).text()).toBe("file fixture");
      expect(permissions).toHaveLength(0);

      const readOnly = join(cwd, "read-only");
      await run(PermissionMode.READ_ONLY, readOnly);
      expect(existsSync(readOnly)).toBe(false);
      expect(permissions).toHaveLength(0);

      const reviewed = join(cwd, "reviewed");
      await run(PermissionMode.ASK, reviewed);
      expect(permissions.some((request) => request.requestJson.includes(reviewed))).toBe(true);
      expect(existsSync(reviewed)).toBe(false);

      const inside = join(cwd, "accepted");
      await run(PermissionMode.ACCEPT_EDITS, inside);
      expect(permissions).toHaveLength(0);
      expect(await Bun.file(inside).text()).toBe("file fixture");

      const outside = join(root, "outside");
      await run(PermissionMode.ACCEPT_EDITS, outside);
      expect(existsSync(outside)).toBe(false);
      await run(PermissionMode.READ_ONLY);
      expect(model.available.has("mcp_canopy_list_threads")).toBe(true);
    } finally {
      await threads.close();
      await model.upstream.stop(true);
      await projectMcp.stop(true);
    }

    expect(existsSync(projectHook)).toBe(false);
    expect(projectRequests).toBe(0);
    expect(calls).toEqual(["list_threads"]);
    expect(permissions).toHaveLength(0);

    const completed = events.flatMap((event) =>
      event.body.case === "itemCompleted" && event.body.value.item?.content.case === "agentBusCall"
        ? [event.body.value.item]
        : [],
    );

    expect(completed).toHaveLength(1);
    expect(completed[0]?.itemId).toContain(":");
  },
  60_000,
);

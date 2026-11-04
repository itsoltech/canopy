import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { GrokClient } from "@canopy/grok-acp";
import { grokLaunch } from "./launch.ts";
import { grokBus } from "./bus.ts";
import { create } from "@bufbuild/protobuf";
import { AgentToolResultSchema } from "@canopy/contracts";

const live = process.env["CANOPY_LIVE"] === "1";
const url = process.env["CANOPY_LIVE_CLIPROXYAPI_URL"];
const key = process.env["CANOPY_LIVE_CLIPROXYAPI_KEY"];

test.skipIf(!live || !url || !key)(
  "Grok CLI through CLIProxyAPI: catalog, shell tool, answer and resume",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "canopy-grok-live-"));
    let client: GrokClient | undefined;
    let launch: ReturnType<typeof grokLaunch> | undefined;
    let platformCalls = 0;

    const bus = grokBus({
      threadId: "live",
      depth: 0,
      turnId: () => "live-turn",
      callTool: async (call) => {
        expect(call.toolName).toBe("list_threads");
        platformCalls++;

        return create(AgentToolResultSchema, { content: "[]" });
      },
    });

    try {
      const response = await fetch(new URL("v1/models", url!.replace(/\/$/, "") + "/"), {
        headers: { Authorization: `Bearer ${key!}` },
        signal: AbortSignal.timeout(15_000),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: { id: string }[] };
      const models = body.data.filter((m) => /grok/i.test(m.id));
      console.info(
        "Proxy Grok models:",
        models.map((m) => m.id),
      );
      expect(models.length).toBeGreaterThan(0);

      const model =
        process.env["CANOPY_LIVE_GROK_MODEL"] || models.find((m) => /fast|mini/i.test(m.id))?.id || models[0]!.id;

      const open = () =>
        grokLaunch({
          dataDir: root,
          profile: {
            kind: "cliproxyapi" as const,
            id: "live",
            providers: ["grok" as const],
            env: {},
            runtime: {},
            baseUrl: new URL(url!),
            apiKey: key!,
          },
          executable: process.env["CANOPY_GROK_EXECUTABLE"] ?? "/home/nix/.local/bin/grok",
          model,
          effort: "low",
          fullAuto: true,
        });

      launch = open();
      client = new GrokClient({
        ...launch.options,
        callbacks: {
          requestPermission: async (r) => ({
            outcome: { outcome: "selected", optionId: r.options.find((o) => o.kind === "allow_once")!.optionId },
          }),
        },
        promptTimeoutMs: 90_000,
      });
      await client.initialize();
      const session = await client.newSession(root, [bus.server]);
      await client.setModel(session.sessionId, model);

      try {
        await client.setMode(session.sessionId, "default");
        console.info("Grok session/set_mode default: supported");
      } catch {
        console.info("Grok session/set_mode default: not supported");
      }

      console.info("Grok modes:", JSON.stringify(session.modes));
      console.info("Grok catalog:", JSON.stringify(session.models));
      let answer = "";
      let tool = false;

      for await (const event of client.prompt(session.sessionId, [
        {
          type: "text",
          text: "Run pwd using your shell tool, call canopy__list_threads exactly once, then answer with the directory and CANOPY_GROK_OK. Do not do anything else.",
        },
      ])) {
        if (event.type === "update") {
          if (event.update.sessionUpdate === "tool_call") {
            tool = true;
            console.info("Grok tool kind:", event.update.kind, "title:", event.update.title);
          }

          if (event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text")
            answer += event.update.content.text;
        }
      }

      expect(tool).toBe(true);
      expect(answer).toContain("CANOPY_GROK_OK");
      expect(platformCalls).toBe(1);
      await client.dispose();
      launch.cleanup();
      launch = open();
      client = new GrokClient(launch.options);
      await client.initialize();
      expect((await client.loadSession(session.sessionId, root, [bus.server])).sessionId).toBe(session.sessionId);
      console.info("Grok proxy shell, platform MCP and restart/load: passed");
    } finally {
      await client?.dispose();
      launch?.cleanup();
      bus.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  120_000,
);

test.skipIf(
  !live ||
    (!process.env["XAI_API_KEY"] &&
      !existsSync(join(process.env["GROK_HOME"] || join(homedir(), ".grok"), "auth.json"))),
)(
  "Grok native login: shell and platform MCP",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "canopy-grok-native-"));
    let calls = 0;

    const bus = grokBus({
      threadId: "native",
      depth: 0,
      turnId: () => "native-turn",
      callTool: async () => {
        calls++;

        return create(AgentToolResultSchema, { content: "[]" });
      },
    });

    const launch = grokLaunch({
      dataDir: root,
      profile: { kind: "native", id: "native", providers: ["grok"], env: {}, runtime: {} },
      executable: process.env["CANOPY_GROK_EXECUTABLE"] ?? "/home/nix/.local/bin/grok",
      effort: "low",
    });

    const client = new GrokClient({
      ...launch.options,
      callbacks: {
        requestPermission: async (r) => ({
          outcome: { outcome: "selected", optionId: r.options.find((o) => o.kind === "allow_once")!.optionId },
        }),
      },
    });

    try {
      await client.initialize();
      const session = await client.newSession(root, [bus.server]);
      let shell = false;
      let answer = "";

      for await (const e of client.prompt(session.sessionId, [
        {
          type: "text",
          text: "Run pwd via your shell, call canopy__list_threads once, then answer CANOPY_NATIVE_OK. Nothing else.",
        },
      ])) {
        if (e.type !== "update") continue;

        if (e.update.sessionUpdate === "tool_call" && e.update.title === "run_terminal_command") shell = true;

        if (e.update.sessionUpdate === "agent_message_chunk" && e.update.content.type === "text")
          answer += e.update.content.text;
      }

      expect(shell).toBe(true);
      expect(calls).toBe(1);
      expect(answer).toContain("CANOPY_NATIVE_OK");
    } finally {
      await client.dispose();
      bus.close();
      launch.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  },
  120_000,
);

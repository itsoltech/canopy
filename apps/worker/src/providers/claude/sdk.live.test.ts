/**
 * Live recordings of the Claude Agent SDK stream (opt-in: CANOPY_LIVE=1 with CANOPY_LIVE_CLIPROXYAPI_URL/KEY).
 * Raw material for the event mapping, like the Codex recordings: every SDK message of a turn is written
 * to $CANOPY_LIVE_RECORD_DIR (default /tmp/oa-claude-recordings).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSdkMcpServer, forkSession, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { tempDir } from "@canopy/testing";
import { z } from "zod";
import { resolveProfiles } from "../profiles.ts";
import { claudeProfileOptions } from "./profile.ts";

const LIVE = process.env["CANOPY_LIVE"] === "1";
const proxyUrl = process.env["CANOPY_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["CANOPY_LIVE_CLIPROXYAPI_KEY"];
const model = process.env["CANOPY_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5";
const recordDir = process.env["CANOPY_LIVE_RECORD_DIR"] ?? "/tmp/oa-claude-recordings";
const home = tempDir("oa-claude-home-");
const cwd = tempDir("oa-claude-cwd-");

function record(name: string, messages: readonly SDKMessage[]): void {
  mkdirSync(recordDir, { recursive: true });
  writeFileSync(join(recordDir, `${name}.jsonl`), messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
}

describe.skipIf(!LIVE || !proxyUrl || !proxyKey)("claude agent sdk (live recordings)", () => {
  const profile = proxyUrl && proxyKey ? resolveProfiles([{ kind: "cliproxyapi", id: "live", baseUrl: proxyUrl, apiKey: proxyKey }])[0]!.resolved! : undefined;
  const sessionId = crypto.randomUUID();
  const tokens: string[] = [];
  const bus = createSdkMcpServer({
    name: "canopy",
    tools: [
      {
        name: "record_token",
        description: "Records a token for the test.",
        inputSchema: z.fromJSONSchema({ type: "object", properties: { token: { type: "string" } }, required: ["token"], additionalProperties: false }) as never,
        handler: async (args: Record<string, unknown>) => {
          tokens.push(String(args["token"]));
          return { content: [{ type: "text" as const, text: "recorded" }] };
        },
      },
    ],
  });
  const run = async (name: string, prompt: string, extra: Record<string, unknown>) => {
    const messages: SDKMessage[] = [];
    for await (const message of query({
      prompt,
      options: {
        cwd,
        model,
        ...claudeProfileOptions(profile!, { ...process.env, CLAUDE_CONFIG_DIR: home }),
        includePartialMessages: true,
        permissionMode: "default",
        canUseTool: async (_tool, input) => ({ behavior: "allow", updatedInput: input }),
        mcpServers: { canopy: bus },
        ...extra,
      },
    })) {
      messages.push(message);
    }
    record(name, messages);
    return messages;
  };

  test("text turn with a preset session id, tool turn on resume, MCP tool, fork without a model call", async () => {
    const first = await run("text-turn", "Reply with exactly the word OK.", { sessionId });
    const result = first.find((m) => m.type === "result");
    expect(result && "result" in result ? result.result : "").toContain("OK");
    expect(first.find((m) => m.type === "system")?.session_id).toBe(sessionId);

    const second = await run(
      "tools-turn",
      'Create hello.txt containing exactly "hi", then run `cat hello.txt` with Bash, then call the record_token tool with token "t1". Reply DONE.',
      { resume: sessionId },
    );
    expect(second.some((m) => m.type === "assistant" && m.message.content.some((b) => b.type === "tool_use" && b.name === "Bash"))).toBe(true);
    expect(tokens).toEqual(["t1"]);
    expect(await Bun.file(join(cwd, "hello.txt")).text()).toContain("hi");

    // Session helpers run in this process and read CLAUDE_CONFIG_DIR from its environment.
    process.env["CLAUDE_CONFIG_DIR"] = home;
    const forked = await forkSession(sessionId, { dir: cwd });
    const third = await run("fork-turn", "What file did you create earlier? Answer with the file name only.", { resume: forked.sessionId });
    const answer = third.find((m) => m.type === "result");
    expect(answer && "result" in answer ? answer.result : "").toContain("hello.txt");
  }, 300_000);
});

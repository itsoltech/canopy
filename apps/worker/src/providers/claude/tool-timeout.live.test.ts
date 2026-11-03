/** Proves the pinned SDK's documented MCP wall-clock limit against the actual CLI, with an isolated home. */
import { describe, expect, test } from "bun:test";
import { createSdkMcpServer, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { tempDirs } from "@canopy/testing";
import { z } from "zod";
import { resolveProfiles } from "../profiles.ts";
import { claudeProfileOptions } from "./profile.ts";

const tempDir = tempDirs();
const url = process.env["CANOPY_LIVE_CLIPROXYAPI_URL"];
const key = process.env["CANOPY_LIVE_CLIPROXYAPI_KEY"];
describe.skipIf(process.env["CANOPY_LIVE"] !== "1" || !url || !key)("Claude MCP timeout (live)", () => {
  test("an in-process MCP call times out even while its handler is still running", async () => {
    let called = false;
    let finished = false;
    const server = createSdkMcpServer({ name: "probe", alwaysLoad: true, timeout: 1000, tools: [{
      name: "wait_probe", description: "A timeout probe; call it once with no arguments.", inputSchema: z.object({}) as never,
      handler: async () => { called = true; await Bun.sleep(2500); finished = true; return { content: [{ type: "text" as const, text: "PROBE_FINISHED" }] }; },
    }] });
    const profile = resolveProfiles([{ kind: "cliproxyapi", id: "live", baseUrl: url!, apiKey: key! }]).find((p) => p.config.id === "live")!.resolved!;
    const messages: SDKMessage[] = [];
    for await (const message of query({ prompt: "Call mcp__probe__wait_probe exactly once. If it errors or times out, reply TIMEOUT. Do not retry it.", options: {
      cwd: tempDir("oa-timeout-cwd-"), model: process.env["CANOPY_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5",
      ...claudeProfileOptions(profile, { ...process.env, CLAUDE_CONFIG_DIR: tempDir("oa-timeout-home-") }),
      mcpServers: { probe: server }, allowedTools: ["mcp__probe__wait_probe"], maxTurns: 3,
      canUseTool: async (_name, input) => ({ behavior: "allow", updatedInput: input }),
    } })) messages.push(message);
    expect(called).toBe(true);
    const results = messages.flatMap((m) => m.type === "user" && Array.isArray(m.message.content) ? m.message.content : []).filter((b) => b.type === "tool_result");
    expect(results.some((r) => r.is_error && /timed out|timeout|exceeded/i.test(JSON.stringify(r.content)))).toBe(true);
    expect(results.some((r) => JSON.stringify(r.content).includes("PROBE_FINISHED"))).toBe(false);
    // Let the local handler finish so no test timer leaks beyond its scope.
    if (!finished) await Bun.sleep(2600);
    expect(finished).toBe(true);
    console.info("Claude MCP: timeout=1000 ms interrupts a 2500 ms in-process tool call");
  }, 120_000);
});

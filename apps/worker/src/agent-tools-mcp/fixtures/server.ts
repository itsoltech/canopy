import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";
import { MAX_BYTES, RpcRequest } from "../protocol.ts";

const eventPath = process.argv[2]!;
const name = process.env["CANOPY_MCP_FIXTURE"] ?? "fixture";

const record = (event: string, id: string | number = 0) =>
  appendFileSync(eventPath, `${JSON.stringify({ event, id, pid: process.pid })}\n`);

record("started");

const input = createInterface({ input: process.stdin });

if (process.env["CANOPY_MCP_STUBBORN"] === "1") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else input.on("close", () => process.exit(0));

input.on("line", (line) => {
  const rpc = RpcRequest.parse(JSON.parse(line));

  const send = (result: z.infer<ReturnType<typeof z.json>>) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n`);

  if (rpc.method === "notifications/cancelled") {
    record("cancelled");

    return;
  }

  if (rpc.id === undefined) return;

  if (rpc.method === "initialize") {
    if (process.env["CANOPY_MCP_NO_INITIALIZE"] === "1") return;
    send({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name, version: "1" },
    });

    return;
  }

  if (rpc.method === "tools/list") {
    if (process.env["CANOPY_MCP_BROWSER_POLICY"] === "1") {
      send({
        tools: ["agent_browser_open", "agent_browser_snapshot", "agent_browser_tab_new", "agent_browser_doctor"].map(
          (toolName) => ({
            name: toolName,
            description: `${name} ${toolName}`,
            inputSchema: {
              type: "object",
              properties:
                toolName === "agent_browser_open" || toolName === "agent_browser_doctor"
                  ? { session: { type: "string" }, headed: { type: "boolean" } }
                  : { session: { type: "string" } },
            },
          }),
        ),
      });

      return;
    }

    send({
      tools: ["image", "echo", "wait", "oversized"].map((toolName) => ({
        name: toolName,
        description: `${name} ${toolName}`,
        inputSchema: { type: "object", additionalProperties: true },
      })),
    });

    return;
  }

  if (rpc.method !== "tools/call") throw new Error("Unexpected fixture method");
  record("called", rpc.id);
  const tool = rpc.params?.["name"];

  if (tool === "wait") return;

  if (tool === "image") {
    send({
      content: [
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        { type: "text", text: name },
      ],
      _meta: { fixture: name },
    });

    return;
  }

  if (tool === "oversized") {
    send({ content: [{ type: "text", text: "x".repeat(MAX_BYTES) }] });

    return;
  }

  send({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          name,
          args: process.argv.slice(3),
          arguments: rpc.params?.["arguments"],
          parentOnly: process.env["CANOPY_MCP_PARENT_ONLY"] ?? "",
          home: process.env["HOME"] ?? "",
          providerKeyPresent: Boolean(process.env["ANTHROPIC_API_KEY"]),
          browserSession: process.env["AGENT_BROWSER_SESSION"] ?? "",
          deviceSession: process.env["AGENT_DEVICE_SESSION"] ?? "",
        }),
      },
    ],
  });
});

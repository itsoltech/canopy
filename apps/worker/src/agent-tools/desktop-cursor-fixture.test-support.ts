import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { objectOf, parseObject, str, type JsonValue } from "@canopy/domain/json";
import { RpcRequest } from "../agent-tools-mcp/protocol.ts";

const dir = process.argv[2]!;

const names = [
  "desktop_cursor_overlay_enable",
  "desktop_cursor_overlay_disable",
  "desktop_click",
  "desktop_type",
  "desktop_snapshot",
  "desktop_find",
  "desktop_screenshot",
  "desktop_press",
  "desktop_get",
  "desktop_list_windows",
  "desktop_mouse_click",
];

createInterface({ input: process.stdin }).on("line", (line) => {
  const rpc = RpcRequest.parse(JSON.parse(line));

  if (rpc.id === undefined) return;

  const send = (result: JsonValue) =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }) + "\n");

  if (rpc.method === "initialize") {
    send({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "Desktop fixture", version: "1" },
    });

    return;
  }

  if (rpc.method === "tools/list") {
    send({ tools: names.map((name) => ({ name, inputSchema: { type: "object" } })) });

    return;
  }

  const name = str(rpc.params?.["name"]);

  if (!names.includes(name)) throw new Error("Unexpected cursor fixture call");
  appendFileSync(join(dir, "cursor-calls"), name + "\n");

  if (name === "desktop_cursor_overlay_enable") throw new Error("Unexpected global cursor overlay");

  const envelope = parseObject(readFileSync(join(dir, name + ".json"), "utf8"));
  const data = { ...objectOf(envelope["data"]) };
  const encoded = str(data["data"]);
  const mimeType = data["format"] === "png" ? "image/png" : "image/jpeg";
  const inline = encoded && ["png", "jpg", "jpeg"].includes(str(data["format"]));

  if (inline) delete data["data"];
  const result = inline ? { ...envelope, data } : envelope;
  send({
    structuredContent: result,
    isError: !envelope["ok"],
    content: [
      { type: "text", text: JSON.stringify(result) },
      ...(inline ? [{ type: "image", mimeType, data: encoded }] : []),
    ],
  });
});

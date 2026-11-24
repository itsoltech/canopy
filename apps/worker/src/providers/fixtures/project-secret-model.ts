import { Schema } from "effect";
import type { JsonObject } from "@canopy/domain";

const requestBody = Schema.decodeUnknownSync(Schema.Struct({ model: Schema.String }));

const sse = (events: readonly object[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });

interface Tool {
  readonly name: string;
  readonly args: JsonObject;
}

function messages(model: string, tool?: Tool) {
  const usage = { input_tokens: 10, output_tokens: 8 };

  const content = tool
    ? { type: "tool_use", id: `toolu_${crypto.randomUUID()}`, name: tool.name, input: {} }
    : { type: "text", text: "Fixture completed." };

  const events = [
    {
      type: "message_start",
      message: { id: crypto.randomUUID(), type: "message", role: "assistant", model, content: [], usage },
    },
    { type: "content_block_start", index: 0, content_block: content },
    ...(tool
      ? [
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.args) },
          },
        ]
      : []),
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage,
    },
    { type: "message_stop" },
  ];

  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function chat(model: string, tool?: Tool) {
  const id = `chat_${crypto.randomUUID()}`;

  const delta = tool
    ? {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            index: 0,
            id: `call_${crypto.randomUUID()}`,
            type: "function",
            function: { name: tool.name, arguments: JSON.stringify(tool.args) },
          },
        ],
      }
    : { role: "assistant", content: "Fixture completed." };

  const chunk = (delta: JsonObject, stop: string | null) => ({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: stop }],
  });

  return sse([chunk(delta, null), chunk({}, tool ? "tool_calls" : "stop")]);
}

/** Record the actual requests from the harness. Tool arguments never contain the fixture value. */
export function projectSecretModel() {
  const steps: (Tool | undefined)[] = [];
  const requests: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;

      if (path.endsWith("/count_tokens")) return Response.json({ input_tokens: 10 });

      if (request.method === "GET")
        return Response.json({ object: "list", data: [{ id: "fixture-grok", object: "model" }] });

      if (path !== "/v1/messages" && path !== "/v1/chat/completions") return new Response(null, { status: 404 });
      const raw = await request.text();
      requests.push(raw);
      const { model } = requestBody(JSON.parse(raw));
      const tool = steps.shift();

      return path === "/v1/messages" ? messages(model, tool) : chat(model, tool);
    },
  });

  return { requests, url: server.url, steps, close: () => server.stop(true) };
}

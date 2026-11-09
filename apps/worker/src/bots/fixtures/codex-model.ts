import { Schema } from "effect";

const Request = Schema.Struct({ input: Schema.Array(Schema.Json) });

/** Script tool calls through the real app-server without credentials or external inference. */
export function codexToolModel(names: string[], namespace?: string) {
  const requests: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = Schema.decodeUnknownSync(Request)(await request.json());
      requests.push(JSON.stringify(body.input));
      const name = names[requests.length - 1];

      const output = name
        ? {
            type: "function_call",
            id: `tool-${requests.length}`,
            call_id: `call-${requests.length}`,
            ...(namespace && { namespace }),
            name,
            arguments: "{}",
          }
        : {
            type: "message",
            id: "answer",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Done", annotations: [] }],
          };

      const events = [
        { type: "response.output_item.done", output_index: 0, item: output },
        {
          type: "response.completed",
          response: {
            id: `response-${requests.length}`,
            status: "completed",
            output: [output],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ];

      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  return { url: server.url.href, requests, stop: () => server.stop(true) };
}

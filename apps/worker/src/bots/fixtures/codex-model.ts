import { Schema } from "effect";
import { isString } from "../../providers/json.ts";

const Request = Schema.Struct({ input: Schema.Array(Schema.Json) });

type ModelStep = string | { name: string; arguments: string } | Response | null;

/** Tool names or calls yield calls, Response entries simulate transport failures, and null yields text. */
export function codexToolModel(steps: readonly ModelStep[], namespace?: string) {
  const requests: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/responses")
        return new Response(null, { status: 404 });

      const body = Schema.decodeUnknownSync(Request)(await request.json());
      requests.push(JSON.stringify(body.input));
      const step = steps[requests.length - 1];

      if (step instanceof Response) return step;
      const call = isString(step) ? { name: step, arguments: "{}" } : step;

      const output = call
        ? {
            type: "function_call",
            id: `tool-${requests.length}`,
            call_id: `call-${requests.length}`,
            ...(namespace && { namespace }),
            ...call,
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

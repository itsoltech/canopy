import type { JsonObject, JsonValue } from "@canopy/domain";
import { decodeJson, isJsonObject, isString, jsonObject, jsonString } from "../../providers/json.ts";

/**
 * A model endpoint for tests and fixture generation (docs/import.md, "Testy"): Anthropic Messages, OpenAI
 * Responses and Chat Completions, streamed like the real APIs, with scripted answers. The real CLIs talk to it,
 * so their session files have the real format without inference or credentials.
 *
 * Markers in the newest user text choose the answer:
 * - FIXTURE_TOOL: a shell tool call (`echo FIXTURE_TOOL_OUTPUT`), then a text answer after its result;
 * - FIXTURE_THINK: reasoning, then text;
 * - FIXTURE_AGENT: Claude's subagent tool with the task FIXTURE_SUBTASK;
 * - anything else: a short text answer naming the marker it saw last.
 * Every request body is kept in `requests` (tests check what a resumed session sent).
 */

export interface FakeModel {
  readonly url: string;
  readonly requests: string[];
  stop(): Promise<void>;
}

const text = (value: JsonValue | undefined): string => {
  if (isString(value)) return value;

  if (Array.isArray(value)) return value.map(text).join("\n");

  if (isJsonObject(value)) return [value["text"], value["content"], value["input"]].map(text).join("\n");

  return "";
};

/** The newest user turn, as text; a tool result after it means "answer the result". */
function last(messages: readonly JsonValue[]) {
  const tail = messages.at(-1);
  const object = jsonObject(tail);
  const content = object?.["content"];

  const toolResult =
    object?.["role"] === "tool" ||
    object?.["type"] === "function_call_output" ||
    object?.["type"] === "custom_tool_call_output" ||
    (Array.isArray(content) && content.some((b) => isJsonObject(b) && b["type"] === "tool_result"));

  const users = messages.filter((m) => {
    const o = jsonObject(m);

    return o?.["role"] === "user" && !text(o["content"]).startsWith("<environment_context>");
  });

  return { said: text(users.at(-1)), toolResult };
}

function answer(said: string): string {
  const marker = /FIXTURE_[A-Z_]+/g.exec(
    said
      .split("\n")
      .filter((l) => l.includes("FIXTURE_"))
      .at(-1) ?? "",
  );

  return `FIXTURE_ANSWER ${marker?.[0] ?? "none"}`;
}

const sse = (events: readonly JsonObject[], named = true) =>
  events.map((e) => `${named ? `event: ${String(e["type"])}\n` : ""}data: ${JSON.stringify(e)}\n\n`).join("");

function anthropic(body: JsonObject, n: number): Response {
  const messages = Array.isArray(body["messages"]) ? body["messages"] : [];
  const { said, toolResult } = last(messages);
  const id = `msg_fixture_${n}`;
  const blocks: JsonObject[] = [];

  if (!toolResult && said.includes("FIXTURE_TOOL"))
    blocks.push({
      type: "tool_use",
      id: `toolu_fixture_${n}`,
      name: "Bash",
      input: { command: "echo FIXTURE_TOOL_OUTPUT", description: "Print the fixture marker" },
    });
  else if (!toolResult && said.includes("FIXTURE_AGENT")) {
    const tools = Array.isArray(body["tools"]) ? body["tools"] : [];

    const name =
      tools.map((t) => jsonString(jsonObject(t)?.["name"])).find((t) => t === "Agent" || t === "Task") ?? "Task";

    blocks.push({
      type: "tool_use",
      id: `toolu_fixture_${n}`,
      name,
      input: { description: "Fixture subtask", prompt: "Say FIXTURE_SUBTASK", subagent_type: "general-purpose" },
    });
  } else {
    if (said.includes("FIXTURE_THINK"))
      blocks.push({
        type: "thinking",
        thinking: "Fixture reasoning about FIXTURE_THINK",
        signature: "fixture-signature",
      });
    blocks.push({ type: "text", text: answer(said) });
  }

  const stop = blocks.some((b) => b["type"] === "tool_use") ? "tool_use" : "end_turn";
  const usage = { input_tokens: 5, output_tokens: 3 };

  if (body["stream"] !== true)
    return Response.json({
      id,
      type: "message",
      role: "assistant",
      model: body["model"],
      content: blocks,
      stop_reason: stop,
      usage,
    });

  const events: JsonObject[] = [
    {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: body["model"] ?? "",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    },
  ];

  blocks.forEach((block, index) => {
    if (block["type"] === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block["text"] ?? "" } });
    } else if (block["type"] === "thinking") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: block["thinking"] ?? "" },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: "fixture-signature" },
      });
    } else {
      events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block["input"]) },
      });
    }

    events.push({ type: "content_block_stop", index });
  });
  events.push(
    { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  );

  return new Response(sse(events), { headers: { "content-type": "text/event-stream" } });
}

interface CodexShell {
  readonly name: string;
  readonly args: JsonObject;
}

/** The shell tool a Codex build offers, with arguments in its own shape. */
function codexShell(tools: readonly JsonValue[]): CodexShell {
  const names = tools.map((t) => jsonString(jsonObject(t)?.["name"]));

  if (names.includes("exec_command")) return { name: "exec_command", args: { cmd: "echo FIXTURE_TOOL_OUTPUT" } };

  if (names.includes("shell_command")) return { name: "shell_command", args: { command: "echo FIXTURE_TOOL_OUTPUT" } };

  return { name: "shell", args: { command: ["bash", "-lc", "echo FIXTURE_TOOL_OUTPUT"] } };
}

function responses(body: JsonObject, n: number): Response {
  const input = Array.isArray(body["input"]) ? body["input"] : [];
  const { said, toolResult } = last(input);
  const tools = Array.isArray(body["tools"]) ? body["tools"] : [];
  const output: JsonObject[] = [];

  if (said.includes("FIXTURE_THINK") && !toolResult)
    output.push({
      type: "reasoning",
      id: `rs_fixture_${n}`,
      summary: [{ type: "summary_text", text: "Fixture reasoning about FIXTURE_THINK" }],
    });

  if (!toolResult && said.includes("FIXTURE_TOOL")) {
    const shell = codexShell(tools);
    output.push({
      type: "function_call",
      id: `fc_fixture_${n}`,
      call_id: `call_fixture_${n}`,
      name: shell.name,
      arguments: JSON.stringify(shell.args),
      status: "completed",
    });
  } else
    output.push({
      type: "message",
      id: `msg_fixture_${n}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: answer(said), annotations: [] }],
    });

  const response = {
    id: `resp_fixture_${n}`,
    object: "response",
    status: "completed",
    model: body["model"] ?? "",
    output,
    usage: {
      input_tokens: 5,
      output_tokens: 3,
      total_tokens: 8,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };

  const events: JsonObject[] = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
  ];

  output.forEach((item, index) => {
    events.push({ type: "response.output_item.added", output_index: index, item });
    events.push({ type: "response.output_item.done", output_index: index, item });
  });
  events.push({ type: "response.completed", response });

  return new Response(sse(events), { headers: { "content-type": "text/event-stream" } });
}

function chat(body: JsonObject, n: number): Response {
  const messages = Array.isArray(body["messages"]) ? body["messages"] : [];
  const { said, toolResult } = last(messages);

  const tools = (Array.isArray(body["tools"]) ? body["tools"] : []).map((t) =>
    jsonString(jsonObject(jsonObject(t)?.["function"])?.["name"]),
  );

  const shell = tools.find((t) => /^(bash|shell|run_terminal|run_command|terminal|execute)/i.test(t));

  const chunk = (delta: JsonObject, finish: string | null = null) => ({
    id: `chat_fixture_${n}`,
    object: "chat.completion.chunk",
    created: 0,
    model: body["model"] ?? "",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  const chunks: JsonObject[] =
    !toolResult && said.includes("FIXTURE_TOOL") && shell
      ? [
          chunk({
            role: "assistant",
            content: null,
            tool_calls: [
              {
                index: 0,
                id: `call_fixture_${n}`,
                type: "function",
                function: {
                  name: shell,
                  arguments: JSON.stringify({
                    command: "echo FIXTURE_TOOL_OUTPUT",
                    description: "Print the fixture marker",
                  }),
                },
              },
            ],
          }),
          chunk({}, "tool_calls"),
        ]
      : [
          ...(said.includes("FIXTURE_THINK")
            ? [chunk({ role: "assistant", reasoning_content: "Fixture reasoning about FIXTURE_THINK" })]
            : []),
          chunk({ role: "assistant", content: answer(said) }),
          chunk({}, "stop"),
        ];

  chunks.push({
    id: `chat_fixture_${n}`,
    object: "chat.completion.chunk",
    created: 0,
    model: body["model"] ?? "",
    choices: [],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  });

  return new Response(`${sse(chunks, false)}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

export function startFakeModel(): FakeModel {
  const requests: string[] = [];
  let n = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;

      if (request.method === "GET")
        return Response.json({
          object: "list",
          data: [
            { id: "fixture-model", object: "model" },
            { id: "fixture-grok", object: "model" },
          ],
          models: [],
        });
      const raw = await request.text();
      requests.push(raw);
      let body: JsonObject = {};

      try {
        body = jsonObject(decodeJson(JSON.parse(raw))) ?? {};
      } catch {
        return Response.json({ error: "not json" }, { status: 400 });
      }

      n += 1;

      if (path.endsWith("/messages/count_tokens")) return Response.json({ input_tokens: 5 });

      if (path.endsWith("/messages")) return anthropic(body, n);

      if (path.endsWith("/responses")) return responses(body, n);

      if (path.endsWith("/chat/completions")) return chat(body, n);

      return Response.json({});
    },
  });

  return { url: server.url.href.replace(/\/$/, ""), requests, stop: () => server.stop(true) };
}

import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { AgentToolResultSchema, Provider, RunBotTurnSchema } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { Schema } from "effect";
import { resolveProfiles } from "../providers/profiles.ts";
import { runClaudeBot } from "./claude.ts";
import { botConnectorMcp } from "./connector-mcp.ts";
import { botSession } from "./session.ts";

const temp = tempDirs();
const readResult = "read_tool_result";

const payloads = new Map([
  ["read_thread", JSON.stringify({ messages: [{ text: "a".repeat(7_977) + "🪴" + "b".repeat(92_448) }] })],
  ["list_schedules", JSON.stringify({ wakeups: [{ prompt: "w".repeat(75_263) }] })],
]);

const tools = [...payloads.keys()].map((name) => ({
  name,
  description: "Return synthetic data",
  inputSchemaJson: '{"type":"object"}',
}));

function fixture(provider: Provider = Provider.CLAUDE, botId: string = crypto.randomUUID()) {
  const input = create(RunBotTurnSchema, {
    botId,
    turnId: crypto.randomUUID(),
    provider,
    model: "claude-haiku-4-5",
    input: "Read the synthetic thread and schedules.",
    tools: [
      ...tools,
      { name: "get_thread", description: "Return a small result", inputSchemaJson: '{"type":"object"}' },
    ],
  });

  const signal = AbortSignal.timeout(20_000);
  const calls: string[] = [];

  const bus = botConnectorMcp(
    {
      callTool: async (call) => {
        calls.push(call.toolName);

        return create(AgentToolResultSchema, { content: payloads.get(call.toolName) ?? '{"title":"Fixture"}' });
      },
      fetchBlob: async () => {
        throw new Error("Unexpected attachment request");
      },
    },
    input,
    signal,
  );

  const { url, headers: entries } = bus.server;
  const headers = Object.fromEntries(entries.map(({ name, value }) => [name, value]));

  return { input, signal, calls, bus, mcp: { url, headers } };
}

const Content = Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }));
const Reference = Schema.Struct({ result_id: Schema.String, next_offset: Schema.NullOr(Schema.Number) });

function chunk(text: string) {
  const newline = text.indexOf("\n");
  const reference = Schema.decodeUnknownSync(Reference)(JSON.parse(text.slice(0, newline)));

  return { ...reference, text: text.slice(newline + 1) };
}

const Result = Schema.Struct({ result: Schema.Struct({ content: Content, isError: Schema.Boolean }) });

async function call(f: ReturnType<typeof fixture>, name: string, args = {}) {
  const response = await fetch(f.mcp.url, {
    method: "POST",
    headers: { ...f.mcp.headers, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  return Schema.decodeUnknownSync(Result)(await response.json()).result;
}

test("Claude bot MCP returns complete oversized results in turn-bound chunks", async () => {
  const active = fixture();
  const anotherTurn = fixture(Provider.CLAUDE, active.input.botId);
  const codex = fixture(Provider.CODEX);

  try {
    for (const [name, expected] of payloads) {
      const first = await call(active, name);
      expect(first.isError).toBe(false);
      expect(first.content[0]?.text.length).toBeLessThan(10_000);
      let page = chunk(first.content[0]!.text);
      const id = page.result_id;
      let actual = page.text;

      expect((await call(anotherTurn, readResult, { result_id: id, offset: 0 })).isError).toBe(true);
      expect((await call(active, readResult, { result_id: id, offset: -1 })).isError).toBe(true);

      if (name === "read_thread")
        expect((await call(active, readResult, { result_id: id, offset: 8_000 })).isError).toBe(true);

      while (page.next_offset !== null) {
        expect(page.next_offset).toBe(actual.length);
        expect(actual).toBe(expected.slice(0, page.next_offset));
        const next = await call(active, readResult, { result_id: id, offset: page.next_offset });
        expect(next.isError).toBe(false);
        page = chunk(next.content[0]!.text);
        actual += page.text;
      }

      expect(actual === expected).toBe(true);
      expect((await call(codex, name)).content[0]?.text === expected).toBe(true);
    }

    expect((await call(active, "get_thread")).content[0]?.text).toBe('{"title":"Fixture"}');
    expect(active.calls).toEqual([...payloads.keys(), "get_thread"]);
    expect(anotherTurn.calls).toEqual([]);
  } finally {
    active.bus.close();
    anotherTurn.bus.close();
    codex.bus.close();
  }
});

const ModelRequest = Schema.Struct({
  messages: Schema.Array(Schema.Struct({ content: Schema.Union([Schema.String, Schema.Array(Schema.Json)]) })),
});

function modelStream(
  content: { type: "tool_use"; id: string; name: string; input: object } | { type: "text"; text: string },
) {
  const usage = { input_tokens: 100, output_tokens: 10 };

  const events = [
    {
      type: "message_start",
      message: {
        id: crypto.randomUUID(),
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [],
        usage,
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: content.type === "tool_use" ? { ...content, input: {} } : content,
    },
    ...(content.type === "tool_use"
      ? [
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(content.input) },
          },
        ]
      : []),
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: content.type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null },
      usage,
    },
    { type: "message_stop" },
  ];

  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

const ToolResult = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.String,
  content: Schema.Union([Schema.String, Content]),
});

const claude = Bun.which("claude");

test.skipIf(!claude)(
  "official Claude CLI can follow a large result without filesystem tools",
  async () => {
    if (!claude) return;
    const f = fixture();
    const home = temp("canopy-claude-tool-result-");
    const received = new Map<string, string>();

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;

        if (path === "/v1/messages/count_tokens") {
          const body = await request.text();

          return Response.json({ input_tokens: Math.ceil(body.length / 2) });
        }

        if (path !== "/v1/messages" || request.method !== "POST") return new Response(null, { status: 404 });
        const body = Schema.decodeUnknownSync(ModelRequest)(await request.json());
        const content = body.messages.at(-1)?.content;
        const result = Schema.is(Schema.String)(content) ? undefined : content?.find(Schema.is(ToolResult));

        if (!result)
          return modelStream({ type: "tool_use", id: "toolu_large", name: "mcp__canopy__read_thread", input: {} });

        const text = Schema.is(Schema.String)(result.content)
          ? result.content
          : result.content.map((block) => block.text).join("\n");

        received.set(result.tool_use_id, text);

        if (result.tool_use_id === "toolu_large" && text.startsWith('{"result_id":')) {
          const page = chunk(text);

          return modelStream({
            type: "tool_use",
            id: "toolu_read",
            name: `mcp__canopy__${readResult}`,
            input: { result_id: page.result_id, offset: page.next_offset },
          });
        }

        return modelStream({ type: "text", text: "Fixture finished." });
      },
    });

    try {
      const profile = resolveProfiles([
        { kind: "cliproxyapi", id: "fixture", baseUrl: server.url.href, apiKey: "fixture", providers: ["claude"] },
      ]).find((p) => p.config.id === "fixture")?.resolved;

      if (!profile) throw new Error("Expected a synthetic proxy profile");

      await runClaudeBot({
        input: f.input,
        profile: {
          ...profile,
          env: { HOME: home, USERPROFILE: home, DISABLE_NONESSENTIAL_TRAFFIC: "1", MAX_MCP_OUTPUT_TOKENS: "25000" },
        },
        executable: claude,
        signal: f.signal,
        clientVersion: "test",
        session: botSession(f.input, { dataDir: home, sourceHome: home, linkLogin: false }),
        mcp: f.mcp,
        record: async () => {},
        noteHarness: async () => {},
        content: async () => ({ text: f.input.input, images: [], documents: [] }),
      });

      const firstText = received.get("toolu_large");
      expect(firstText && !firstText.includes("/tool-results/")).toBe(true);
      expect(firstText?.startsWith('{"result_id":"')).toBe(true);
      const first = chunk(firstText!);
      const next = chunk(received.get("toolu_read")!);
      const expected = payloads.get("read_thread")!;

      expect(first.next_offset).toBe(7_999);
      expect(next.next_offset).toBe(15_999);
      expect(first.text.startsWith(expected.slice(0, first.next_offset!))).toBe(true);
      expect(next.text.startsWith(expected.slice(first.next_offset!, next.next_offset!))).toBe(true);
    } finally {
      f.bus.close();
      await server.stop(true);
    }
  },
  25_000,
);

import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, RunBotTurnSchema } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { Schema } from "effect";
import { grokBus } from "../providers/grok/bus.ts";
import { resolveProfiles } from "../providers/profiles.ts";
import { runClaudeBot } from "./claude.ts";
import { runCodexBot } from "./codex.ts";
import { botSession } from "./session.ts";

const temp = tempDirs();

const Tool = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  tools: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
});

const Inference = Schema.Struct({ tools: Schema.optionalKey(Schema.Array(Tool)) });

for (const provider of [Provider.CLAUDE, Provider.CODEX]) {
  const name = provider === Provider.CLAUDE ? "claude" : "codex";
  test.skipIf(!Bun.which(name))(
    `${name} offers only Canopy MCP schemas to the model`,
    async () => {
      const dir = temp("canopy-bot-isolation-");
      const seen = Promise.withResolvers<typeof Inference.Type>();
      const requests: (typeof Inference.Type)[] = [];
      const abort = new AbortController();

      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          if (request.method === "POST" && /\/(messages|responses)$/.test(new URL(request.url).pathname)) {
            const body = await request.json();
            const parsed = Schema.decodeUnknownSync(Inference)(body);
            requests.push(parsed);

            if (JSON.stringify(body).includes("Run ls") && parsed.tools?.length) seen.resolve(parsed);
          }

          return Response.json(
            { type: "error", error: { type: "invalid_request_error", message: "fixture refuses inference" } },
            { status: 400 },
          );
        },
      });

      const input = create(RunBotTurnSchema, {
        botId: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        provider,
        profileId: "fixture",
        model: provider === Provider.CLAUDE ? "claude-haiku-5-5" : "gpt-6.1-sol",
        effort: "low",
        instructions: "Use only Canopy tools.",
        historyJson: "[]",
        input: "Run ls using a shell tool now.",
        tools: [
          {
            name: "fixture_only",
            description: "Read fixture state",
            inputSchemaJson: '{"type":"object","properties":{}}',
          },
        ],
      });

      const profile = resolveProfiles([
        { kind: "cliproxyapi", id: "fixture", baseUrl: server.url.href, apiKey: "fixture", providers: [name] },
      ]).find((p) => p.config.id === "fixture")!.resolved!;

      const bus = grokBus({
        threadId: input.botId,
        depth: 0,
        agentBus: false,
        connectorTools: input.tools,
        turnId: () => input.turnId,
        callTool: async () => {
          throw new Error("Inference fixture never calls tools");
        },
      });

      if (!("url" in bus.server)) throw new Error("Expected HTTP MCP");

      const context = {
        input,
        profile,
        executable: name,
        signal: abort.signal,
        clientVersion: "test",
        session: botSession(input, { dataDir: dir, sourceHome: dir, linkLogin: false }),
        mcp: { url: bus.server.url, headers: Object.fromEntries(bus.server.headers.map((h) => [h.name, h.value])) },
        record: async () => {},
        noteHarness: async () => {},
      };

      const done = (provider === Provider.CLAUDE ? runClaudeBot(context) : runCodexBot(context)).catch(() => undefined);

      const timer = setTimeout(() => {
        abort.abort();
        seen.reject(new Error("Official CLI did not send inference"));
      }, 20_000);

      try {
        const tools = (await seen.promise).tools ?? [];
        expect(tools.length).toBeGreaterThan(0);

        if (provider === Provider.CLAUDE) expect(tools.map((t) => t.name)).toEqual(["mcp__canopy__fixture_only"]);
        else {
          expect(tools.map((t) => t.name).sort()).toEqual([
            "list_mcp_resource_templates",
            "list_mcp_resources",
            "mcp__canopy",
            "read_mcp_resource",
          ]);
          expect(tools.find((t) => t.name === "mcp__canopy")?.tools?.map((t) => t.name)).toEqual(["fixture_only"]);
        }

        expect(
          requests
            .flatMap((r) => r.tools ?? [])
            .every((t) =>
              [
                "mcp__canopy__fixture_only",
                "list_mcp_resource_templates",
                "list_mcp_resources",
                "mcp__canopy",
                "read_mcp_resource",
              ].includes(t.name ?? ""),
            ),
        ).toBe(true);
      } finally {
        clearTimeout(timer);
        abort.abort();
        await done;
        bus.close();
        await server.stop(true);
      }
    },
    25_000,
  );
}

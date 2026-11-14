import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, RunBotTurnSchema } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { grokBus } from "../providers/grok/bus.ts";
import { resolveProfiles } from "../providers/profiles.ts";
import { grokLaunch } from "../providers/grok/launch.ts";
import { runClaudeBot } from "./claude.ts";
import { runCodexBot } from "./codex.ts";
import { runGrokBot } from "./grok.ts";
import { botSession } from "./session.ts";

const temp = tempDirs();

const Tool = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  tools: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
  function: Schema.optionalKey(Schema.Struct({ name: Schema.String })),
});

const Inference = Schema.Struct({ tools: Schema.optionalKey(Schema.Array(Tool)) });

function userEnvironment(home: string) {
  const skill = "fixture-private-user-skill";
  const instruction = "FIXTURE_PRIVATE_USER_INSTRUCTIONS";
  const roots = [".agents", ".codex", ".claude", ".grok", ".config/codex"];

  for (const root of roots) {
    const path = join(home, root);
    const skills = join(path, "skills", skill);
    mkdirSync(skills, { recursive: true });
    writeFileSync(
      join(skills, "SKILL.md"),
      `---\nname: ${skill}\ndescription: Private user fixture\n---\n${instruction}\n`,
    );

    for (const file of ["AGENTS.md", "CLAUDE.md"]) writeFileSync(join(path, file), instruction);
  }

  for (const file of ["AGENTS.md", "CLAUDE.md"]) writeFileSync(join(home, file), instruction);

  return {
    env: {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      GROK_HOME: join(home, ".grok"),
    },
    forbidden: [...roots.map((root) => join(home, root, "skills")), skill, instruction],
  };
}

test("bot isolation keeps only the selected login and rebuilds pre-isolation sessions", () => {
  const user = userEnvironment(temp("canopy-bot-login-"));

  for (const provider of [Provider.CLAUDE, Provider.CODEX]) {
    const sourceHome = provider === Provider.CLAUDE ? user.env.CLAUDE_CONFIG_DIR : user.env.CODEX_HOME;
    const login = provider === Provider.CLAUDE ? ".credentials.json" : "auth.json";
    writeFileSync(join(sourceHome, login), "{}");

    const input = create(RunBotTurnSchema, {
      botId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      provider,
      model: "fixture",
    });

    const options = { dataDir: temp("canopy-bot-login-data-"), sourceHome, linkLogin: true };
    const session = botSession(input, options);

    if (provider === Provider.CLAUDE) {
      expect(readdirSync(session.home)).toEqual([]);
      expect(session.secureStorageDir).toBe(sourceHome);
      expect(botSession(input, { ...options, secureStorageDir: "" }).secureStorageDir).toBe("");
      const isolated = botSession(input, { ...options, linkLogin: false });
      expect(isolated.secureStorageDir).toBe(isolated.home);
    } else {
      expect(readdirSync(session.home)).toEqual([login]);
      expect(readlinkSync(join(session.home, login))).toBe(join(sourceHome, login));
    }

    for (const configuration of [
      { model: input.model, tools: input.tools },
      { isolation: 2, model: input.model, tools: input.tools },
      { isolation: 2, model: input.model, effort: input.effort, tools: input.tools, configuration: input.instructions },
    ]) {
      const key = createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
      writeFileSync(join(session.home, "..", "session.json"), JSON.stringify({ id: "old-session", key }));
      expect(botSession(input, options).id).toBe("");
    }

    session.save("isolated-session");
    expect(botSession(input, options).id).toBe("isolated-session");

    // Older gateways omit configuration_key; edited prompts must still invalidate the session.
    input.instructions = "Updated standing instructions";
    expect(botSession(input, options).id).toBe("");
  }
});

test("Grok login uses the selected auth path; only bots replace the shell home", () => {
  const user = userEnvironment(temp("canopy-bot-grok-login-"));
  const sourceHome = user.env.GROK_HOME;
  const auth = join(sourceHome, "auth.json");
  writeFileSync(auth, "{}");

  for (const [linkDeviceLogin, bot] of [
    [true, true],
    [false, true],
    [true, false],
    [false, false],
  ] as const) {
    const launch = grokLaunch({
      dataDir: temp("canopy-bot-grok-data-"),
      profile: {
        kind: "native",
        id: "fixture",
        providers: ["grok"],
        env: { ...user.env, GROK_AUTH_PATH: join(user.env.HOME, "wrong-auth.json") },
        runtime: { homePath: sourceHome },
      },
      linkDeviceLogin,
      ...(bot && { bot: { cwd: sourceHome, instructions: "Use only Canopy tools.", sourceHome } }),
    });

    try {
      expect(launch.options.env?.["HOME"]).toBe(bot ? launch.options.env?.["GROK_HOME"] : user.env.HOME);
      expect(launch.options.env?.["GROK_AUTH_PATH"]).toBe(linkDeviceLogin ? auth : undefined);
    } finally {
      launch.cleanup();
    }
  }
});

test("Grok carries the terminal's custom auth path into threads and bots", () => {
  const home = temp("canopy-grok-custom-auth-");
  const auth = join(home, "custom-login.json");

  for (const bot of [false, true]) {
    const launch = grokLaunch({
      dataDir: temp("canopy-grok-custom-data-"),
      profile: { kind: "native", id: "native", providers: ["grok"], env: {}, runtime: {} },
      baseEnv: { GROK_HOME: home, GROK_AUTH_PATH: auth },
      ...(bot && { bot: { cwd: home, sourceHome: home, instructions: "Use Canopy tools." } }),
    });

    try {
      expect(launch.options.env?.["GROK_AUTH_PATH"]).toBe(auth);
    } finally {
      launch.cleanup();
    }
  }
});

for (const webAccess of [false, true]) {
  for (const provider of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) {
    const name = provider === Provider.CLAUDE ? "claude" : provider === Provider.CODEX ? "codex" : "grok";
    test.skipIf(!Bun.which(name))(
      `${name} offers Canopy MCP and web tools only when web access is ${webAccess}`,
      async () => {
        const dir = temp("canopy-bot-isolation-");
        const user = userEnvironment(temp("canopy-bot-user-"));
        const seen = Promise.withResolvers<typeof Inference.Type>();
        const requests: (typeof Inference.Type)[] = [];
        const captured: string[] = [];
        const abort = new AbortController();

        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: async (request) => {
            if (
              request.method === "POST" &&
              /\/(messages|responses|chat\/completions)$/.test(new URL(request.url).pathname)
            ) {
              const body = await request.json();
              const parsed = Schema.decodeUnknownSync(Inference)(body);
              requests.push(parsed);
              captured.push(JSON.stringify(body));

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
          webAccess,
          model:
            provider === Provider.CLAUDE
              ? "claude-haiku-5-5"
              : provider === Provider.CODEX
                ? "gpt-6.1-sol"
                : "fixture-grok",
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
          profile: { ...profile, env: user.env },
          executable: name,
          signal: abort.signal,
          clientVersion: "test",
          session: botSession(input, { dataDir: dir, sourceHome: dir, linkLogin: false }),
          mcp: { url: bus.server.url, headers: Object.fromEntries(bus.server.headers.map((h) => [h.name, h.value])) },
          record: async () => {},
          noteHarness: async () => {},
          content: async () => ({ text: input.input, images: [], documents: [] }),
        };

        const done = (
          provider === Provider.CLAUDE
            ? runClaudeBot(context)
            : provider === Provider.CODEX
              ? runCodexBot(context)
              : runGrokBot(context)
        ).catch(() => undefined);

        const timer = setTimeout(() => {
          abort.abort();
          seen.reject(new Error("Official CLI did not send inference"));
        }, 20_000);

        try {
          const tools = (await seen.promise).tools ?? [];
          abort.abort();
          await done;
          expect(tools.length).toBeGreaterThan(0);

          if (provider === Provider.CLAUDE)
            expect(tools.map((t) => t.name).sort()).toEqual(
              [...(webAccess ? ["WebFetch", "WebSearch"] : []), "mcp__canopy__fixture_only"].sort(),
            );
          else if (provider === Provider.CODEX) {
            expect(tools.some((t) => t.type === "web_search")).toBe(webAccess);
            expect(
              tools
                .filter((t) => t.name)
                .map((t) => t.name)
                .sort(),
            ).toEqual(["list_mcp_resource_templates", "list_mcp_resources", "mcp__canopy", "read_mcp_resource"]);
            expect(tools.find((t) => t.name === "mcp__canopy")?.tools?.map((t) => t.name)).toEqual(["fixture_only"]);
          } else
            expect(tools.map((t) => t.function?.name).sort()).toEqual(
              [...(webAccess ? ["web_fetch", "web_search"] : []), "search_tool", "use_tool"].sort(),
            );

          expect(
            requests
              .flatMap((r) => r.tools ?? [])
              .every(
                (t) =>
                  (webAccess && t.type === "web_search") ||
                  [
                    ...(webAccess ? ["WebFetch", "WebSearch", "web_fetch", "web_search"] : []),
                    "mcp__canopy__fixture_only",
                    "list_mcp_resource_templates",
                    "list_mcp_resources",
                    "mcp__canopy",
                    "read_mcp_resource",
                    "search_tool",
                    "use_tool",
                  ].includes(t.name ?? t.function?.name ?? ""),
              ),
          ).toBe(true);

          expect(captured.some((body) => body.includes("<skills_instructions>"))).toBe(false);

          for (const marker of user.forbidden)
            expect(
              captured.some((body) => body.includes(marker)),
              `User context leaked: ${marker}`,
            ).toBe(false);
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
}

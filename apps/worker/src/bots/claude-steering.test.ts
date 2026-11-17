import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, RunBotTurnSchema } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { runClaudeBot } from "./claude.ts";
import { botSession } from "./session.ts";
import { BotSteering } from "./steering.ts";
import { resolveProfiles } from "../providers/profiles.ts";
import type { ThreadEventInit } from "../journal/index.ts";

const tempDir = tempDirs();

function response() {
  const events = [
    {
      type: "message_start",
      message: {
        id: crypto.randomUUID(),
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "DONE" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];

  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

test.skipIf(!Bun.which("claude"))(
  "official Claude consumes queued bot input after the preceding result",
  async () => {
    const root = tempDir("canopy-claude-bot-steer-");
    const seen = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const requests: string[] = [];
    const notices: ThreadEventInit[] = [];
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15_000);

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname;

        if (path.endsWith("/count_tokens")) return Response.json({ input_tokens: 1 });

        if (!path.endsWith("/messages")) return Response.json({ data: [] });
        const body = await request.text();
        requests.push(body);

        if (body.includes("INITIAL_MESSAGE") && !body.includes("STEER_MARKER")) {
          seen.resolve();
          await release.promise;
        }

        return response();
      },
    });

    const input = create(RunBotTurnSchema, {
      botId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      provider: Provider.CLAUDE,
      profileId: "fixture",
      model: "claude-haiku-5-5",
      input: "INITIAL_MESSAGE",
    });

    const profile = resolveProfiles([
      { kind: "cliproxyapi", id: "fixture", providers: ["claude"], baseUrl: server.url.href, apiKey: "fixture" },
    ]).find((p) => p.config.id === "fixture")!.resolved!;

    const session = botSession(input, { dataDir: root, sourceHome: "", linkLogin: false });

    const record = async (event: ThreadEventInit) => {
      notices.push(event);
    };

    const steering = new BotSteering(session, record);

    const done = runClaudeBot({
      input,
      profile: { ...profile, env: { HOME: root, USERPROFILE: root } },
      session,
      steering,
      record,
      executable: "claude",
      signal: abort.signal,
      clientVersion: "test",
      mcp: { url: "", headers: {} },
      noteHarness: async () => {},
      content: async () => ({ text: input.input, images: [], documents: [] }),
    });

    void done.catch(() => {});

    try {
      await Promise.race([seen.promise, done]);
      const inputId = crypto.randomUUID();
      expect(steering.submit(inputId, "STEER_MARKER")).toBe("queued");
      await Bun.sleep(100);
      expect(
        notices.some((event) => event.body?.case === "notice" && event.body.value.code === "bot_steer_applied"),
      ).toBe(false);
      release.resolve();
      await done;
      expect(requests.slice(1).some((request) => request.includes("STEER_MARKER"))).toBe(true);
      expect(
        notices.filter((event) => event.body?.case === "notice" && event.body.value.code === "bot_steer_applied"),
      ).toHaveLength(1);
    } finally {
      release.resolve();
      abort.abort();
      await done.catch(() => {});
      await steering.close();
      clearTimeout(timer);
      server.stop(true);
    }
  },
  20_000,
);

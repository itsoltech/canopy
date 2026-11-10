import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, RunBotTurnSchema } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { runGrokBot } from "./grok.ts";
import { botSession } from "./session.ts";
import { readGrokTurn } from "../providers/grok/transcript.ts";
import type { TurnHarness } from "../journal/index.ts";
import { TurnOutcome } from "@canopy/contracts";

const temp = tempDirs();

test.skipIf(!Bun.which("grok"))(
  "Grok persists resumed bot turns with separate transcript offsets",
  async () => {
    const root = temp("canopy-grok-transcript-");

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        request.method === "GET"
          ? Response.json({ data: [{ id: "fixture-grok" }] })
          : new Response(
              `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture-grok", choices: [{ index: 0, delta: { role: "assistant", content: "TRANSCRIPT_OK" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture-grok", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            ),
    });

    const input = create(RunBotTurnSchema, {
      botId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      provider: Provider.GROK,
      profileId: "fixture",
      model: "fixture-grok",
      historyJson: "[]",
      input: "Say TRANSCRIPT_OK",
      instructions: "You are a conversational assistant.",
    });

    let harness: TurnHarness | undefined;
    let previousSession = "";

    try {
      for (let turn = 0; turn < 2; turn += 1) {
        input.turnId = crypto.randomUUID();
        const session = botSession(input, { dataDir: root, sourceHome: root, linkLogin: false });
        await runGrokBot({
          input,
          session,
          executable: "grok",
          signal: AbortSignal.timeout(20_000),
          clientVersion: "test",
          profile: {
            kind: "cliproxyapi",
            id: "fixture",
            providers: ["grok"],
            baseUrl: server.url,
            apiKey: "fixture",
            env: {},
            runtime: {},
          },
          mcp: { url: "", headers: {} },
          record: async () => {},
          content: async () => ({ text: input.input, images: [], documents: [] }),
          noteHarness: async (value) => {
            harness = value;
          },
        });

        if (!harness) throw new Error("Harness record missing");

        if (turn > 0) {
          expect(harness.sessionId).toBe(previousSession);
          expect(harness.offset).toBeGreaterThan(0);
        }

        previousSession = harness.sessionId;
        const record = await readGrokTurn(harness.transcript, harness.sessionId, harness.offset, input.turnId);
        expect(record?.end?.outcome).toBe(TurnOutcome.COMPLETED);
        expect(
          record?.items
            .filter((i) => i.content?.case === "agentMessage")
            .map((i) => (i.content?.case === "agentMessage" ? i.content.value.text : "")),
        ).toEqual(["TRANSCRIPT_OK"]);
      }
    } finally {
      server.stop(true);
    }
  },
  45_000,
);

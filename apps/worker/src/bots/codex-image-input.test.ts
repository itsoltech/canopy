import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import { AgentToolResultSchema, Provider, RunBotTurnSchema } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { Schema } from "effect";
import sharp from "sharp";
import { forModel } from "../images/normalize.ts";
import { resolveProfiles } from "../providers/profiles.ts";
import { botConnectorMcp } from "./connector-mcp.ts";
import { runCodexBot } from "./codex.ts";
import { botSession } from "./session.ts";

const temp = tempDirs();
const TOOL_NAME = "slack_import_fixture";
const CALL_ID = "import-image";

const Request = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.optionalKey(Schema.String),
      tools: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
    }),
  ),
  input: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      call_id: Schema.optionalKey(Schema.String),
      role: Schema.optionalKey(Schema.String),
      content: Schema.optionalKey(Schema.Json),
      output: Schema.optionalKey(Schema.Json),
    }),
  ),
});

const decodeRequest = Schema.decodeUnknownSync(Request);

function responseStream(item: Schema.Json, id: string) {
  const events = [
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];

  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function imageImportModel() {
  const requests: (typeof Request.Type)[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/responses")
        return new Response(null, { status: 404 });

      const body = decodeRequest(await request.json());

      requests.push(body);

      if (requests.length > 1)
        return responseStream(
          {
            type: "message",
            id: "answer",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Done", annotations: [] }],
          },
          "response-answer",
        );

      const namespace = body.tools.find((tool) => tool.tools?.some((member) => member.name === TOOL_NAME))?.name;

      if (!namespace) throw new Error("The first model request did not advertise the MCP import tool");

      return responseStream(
        {
          type: "function_call",
          id: "import",
          call_id: CALL_ID,
          namespace,
          name: TOOL_NAME,
          arguments: "{}",
        },
        "response-import",
      );
    },
  });

  return { server, requests };
}

test.skipIf(!Bun.which("codex"))(
  "official Codex passes bot images from the user message and the connector result to the model",
  async () => {
    const dir = temp("canopy-codex-image-");

    const png = await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 240, g: 32, b: 64, alpha: 0.5 } },
    })
      .png()
      .toBuffer();

    const normalized = await forModel(png);

    const attachment = {
      attachmentId: crypto.randomUUID(),
      name: "fixture.png",
      kind: "image",
      mimeType: "image/png",
      sha256: createHash("sha256").update(png).digest("hex"),
      sizeBytes: BigInt(png.length),
    };

    const input = create(RunBotTurnSchema, {
      botId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      provider: Provider.CODEX,
      model: "gpt-6.1-sol",
      instructions: "Use the import tool to get the image.",
      input: "Import the image",
      historyJson: "[]",
      tools: [{ name: TOOL_NAME, description: "Import an image", inputSchemaJson: '{"type":"object"}' }],
    });

    const signal = AbortSignal.timeout(15_000);
    const blobReads: string[][] = [];

    const mcp = botConnectorMcp(
      {
        callTool: async (call) =>
          create(AgentToolResultSchema, { callId: call.callId, content: "Image imported", attachments: [attachment] }),
        fetchBlob: async (botId, sha, turnId) => {
          if (!turnId) throw new Error("The connector download requires the bot turn ID");
          blobReads.push([botId, sha, turnId]);

          return png;
        },
      },
      input,
      signal,
    );

    const { server, requests } = imageImportModel();

    try {
      const profile = resolveProfiles([
        { kind: "cliproxyapi", id: "fixture", baseUrl: server.url.href, apiKey: "fixture", providers: ["codex"] },
      ]).find((entry) => entry.config.id === "fixture")?.resolved;

      if (!profile) throw new Error("Could not resolve the loopback model profile");

      await runCodexBot({
        input,
        profile,
        executable: "codex",
        clientVersion: "test",
        signal,
        session: botSession(input, { dataDir: dir, sourceHome: dir, linkLogin: false }),
        mcp: { url: mcp.server.url, headers: Object.fromEntries(mcp.server.headers.map((h) => [h.name, h.value])) },
        record: async () => {},
        noteHarness: async () => {},
        content: async () => ({ text: input.input, images: [normalized], documents: [] }),
      });

      expect(blobReads).toEqual([[input.botId, attachment.sha256, input.turnId]]);
      expect(requests[0]?.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.arrayContaining([expect.objectContaining({ type: "input_image" })]),
          }),
        ]),
      );

      const result = requests[1]?.input.find(
        (item) => item.type === "function_call_output" && item.call_id === CALL_ID,
      );

      expect(result?.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "input_text", text: "Image imported" }),
          expect.objectContaining({
            type: "input_image",
            image_url: expect.stringMatching(/^data:image\/png;base64,iVBOR/),
          }),
        ]),
      );
    } finally {
      mcp.close();
      await server.stop(true);
    }
  },
  20_000,
);

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  ConnectorToolSchema,
  InputAttachmentSchema,
  RunBotTurnSchema,
  WelcomeSchema,
  type AgentToolResult,
} from "@canopy/contracts";
import { attachmentPath } from "@canopy/domain";
import { tempDir } from "@canopy/testing";
import { ManagedRuntime } from "effect";
import sharp from "sharp";
import { Journal } from "../journal/index.ts";
import { botConnectorMcp } from "../bots/connector-mcp.ts";
import type { WorkerPayloadInit } from "../gateway-link/index.ts";
import { platformMcp, type PlatformMcp } from "../providers/mcp-bus.ts";
import { HostState } from "./host-state.ts";
import { HostContext } from "./host-context.ts";

const TOOL = create(ConnectorToolSchema, {
  accountId: "slack-account",
  name: "slack_download",
  remoteName: "download_file",
  inputSchemaJson: '{"type":"object"}',
});

const bytes = (text: string) => new TextEncoder().encode(text);

function fixture() {
  const dataDir = tempDir("canopy-tool-attachments-");
  const runtime = ManagedRuntime.make(Journal.layer(join(dataDir, "journal.db")));
  const state = new HostState({ runtime, dataDir, clientVersion: "test" });
  const host = new HostContext(state, { applyConfig: async () => ({}), sendPreviews: () => {} });
  const calls: WorkerPayloadInit[] = [];
  let result = create(AgentToolResultSchema);
  let blobs = new Map<string, Uint8Array>();

  state.link = {
    welcome: create(WelcomeSchema),
    messages: { async *[Symbol.asyncIterator]() {} },
    closed: Promise.resolve({}),
    close: () => {},
    send(payload) {
      calls.push(payload);

      if (payload.case === "agentToolCall" && payload.value.callId) {
        const pending = state.toolCalls.get(payload.value.callId);
        state.toolCalls.delete(payload.value.callId);
        pending?.resolve(result);
      }

      if (payload.case === "fetchBlob" && payload.value.requestId && payload.value.sha256) {
        const pending = state.fetches.get(payload.value.requestId);
        const data = blobs.get(payload.value.sha256);

        if (data) pending?.resolve(data);
        else pending?.reject(new Error("Missing blob"));
      }
    },
  };

  return {
    dataDir,
    root: state.files.root,
    worker: host.ops,
    calls,
    answer(value: AgentToolResult, data: Map<string, Uint8Array>) {
      result = value;
      blobs = data;
    },
    async close() {
      await host.ops.closeBots();
      await runtime.dispose();
    },
  };
}

function ref(name: string, data: Uint8Array, mimeType: string, kind = "file") {
  return create(InputAttachmentSchema, {
    attachmentId: crypto.randomUUID(),
    name,
    mimeType,
    kind,
    sizeBytes: BigInt(data.length),
    sha256: createHash("sha256").update(data).digest("hex"),
  });
}

async function call(bus: PlatformMcp) {
  const { url, headers } = bus.server;

  const response = await fetch(url, {
    method: "POST",
    headers: Object.fromEntries(headers.map((header) => [header.name, header.value])),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: TOOL.name } }),
  });

  expect(response.ok).toBe(true);

  return (await response.json()) as { result: { isError: boolean; content: object[] } };
}

test("project connector paths are available on MCP success and subject to attachment scope and integrity", async () => {
  const f = fixture();
  const threadId = crypto.randomUUID();
  const turnId = crypto.randomUUID();

  const bus = platformMcp({
    depth: 0,
    threadId,
    turnId: () => turnId,
    agentBus: false,
    connectorTools: [TOOL],
    callTool: f.worker.callTool,
  });

  const data = bytes("file from Slack");
  const file = ref("notes.txt", data, "text/plain");
  file.path = attachmentPath(f.root, process.platform, threadId, file.attachmentId, file.name);

  try {
    const content = `Downloaded to ${file.path}`;
    f.answer(create(AgentToolResultSchema, { content, attachments: [file] }), new Map([[file.sha256, data]]));
    expect((await call(bus)).result).toEqual({ content: [{ type: "text", text: content }], isError: false });
    expect(readFileSync(file.path, "utf8")).toBe("file from Slack");
    expect(f.calls.filter((entry) => entry.case === "fetchBlob").map((entry) => entry.value)).toEqual([
      expect.objectContaining({ threadId, sha256: file.sha256, botId: "", botTurnId: "" }),
    ]);

    const wrongPath = join(f.dataDir, file.name);
    file.path = wrongPath;
    f.answer(create(AgentToolResultSchema, { content: wrongPath, attachments: [file] }), new Map());
    expect((await call(bus)).result).toMatchObject({ isError: true });
    expect(existsSync(wrongPath)).toBe(false);
    expect(f.calls.filter((entry) => entry.case === "fetchBlob")).toHaveLength(1);

    const damaged = ref("damaged.txt", data, "text/plain");
    damaged.path = attachmentPath(f.root, process.platform, threadId, damaged.attachmentId, damaged.name);
    f.answer(
      create(AgentToolResultSchema, { content: damaged.path, attachments: [damaged] }),
      new Map([[damaged.sha256, bytes("file from Else!")]]),
    );
    expect((await call(bus)).result).toMatchObject({ isError: true });
    expect(existsSync(damaged.path)).toBe(false);
  } finally {
    bus.close();
    await f.close();
  }
});

test("bot connector returns native MCP images, bounded text and forwardable references using the active turn scope", async () => {
  const f = fixture();
  const botId = crypto.randomUUID();
  const turnId = crypto.randomUUID();

  const data = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "#37e" },
  })
    .png()
    .toBuffer();

  const text = bytes(`start ${"a".repeat(64_000)} end`);
  const binary = new Uint8Array([0, 0, 0, 255]);
  const image = ref("snapshot.png", data, "image/png", "image");
  const doc = ref("notes.txt", text, "text/plain");
  const file = ref("archive.dat", binary, "application/octet-stream");
  const attachments = [image, doc, file];
  const input = create(RunBotTurnSchema, { botId, turnId, tools: [TOOL] });
  const bus = botConnectorMcp(f.worker, input, new AbortController().signal);

  try {
    f.answer(
      create(AgentToolResultSchema, { content: "Files downloaded", attachments }),
      new Map([
        [image.sha256, data],
        [doc.sha256, text],
        [file.sha256, binary],
      ]),
    );
    const { result } = await call(bus);
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([
      { type: "text", text: "Files downloaded" },
      { type: "text", text: expect.stringContaining(image.attachmentId) },
      { type: "image", mimeType: "image/jpeg", data: expect.stringMatching(/^\/9j\//) },
      { type: "text", text: expect.stringContaining("Canopy truncated this file") },
      {
        type: "text",
        text: expect.stringContaining(
          `Attachment [${file.attachmentId}] "archive.dat" (application/octet-stream, 4 bytes)`,
        ),
      },
    ]);
    expect(JSON.stringify(result)).toContain(doc.attachmentId);
    expect(JSON.stringify(result)).not.toContain(" end");
    expect(f.calls[0]).toMatchObject({
      case: "agentToolCall",
      value: { botId, turnId, connectorAccountId: TOOL.accountId },
    });
    expect(f.calls.filter((entry) => entry.case === "fetchBlob").map((entry) => entry.value)).toEqual(
      attachments.map(({ sha256 }) => expect.objectContaining({ threadId: "", botId, botTurnId: turnId, sha256 })),
    );
    expect(existsSync(join(f.root, botId))).toBe(false);

    f.answer(
      create(AgentToolResultSchema, { content: "File downloaded", attachments: [image] }),
      new Map([[image.sha256, bytes("Wrong bytes")]]),
    );
    expect((await call(bus)).result).toEqual({
      isError: true,
      content: [
        { type: "text", text: "File downloaded" },
        { type: "text", text: expect.stringContaining(`Attachment [${image.attachmentId}]`) },
      ],
    });
  } finally {
    bus.close();
    await f.close();
  }
});

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "@canopy/testing";
import { ItemStatus } from "@canopy/contracts";
import { ManagedRuntime } from "effect";
import type { SessionUpdate } from "@canopy/grok-acp";
import { PreviewStore, inlineImages } from "./index.ts";
import { GrokEventMapper } from "../providers/grok/mapping.ts";
import { Journal } from "../journal/index.ts";
import { WorkerHost } from "../runtime/host.ts";

const temporary = tempDirs();
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const image = { type: "image", data: png, mimeType: "image/png" };

test("Grok ACP image previews survive completion patches, deduplicate MCP output and persist across store restart", async () => {
  const data = temporary("canopy-grok-image-patches-");
  const previews = new PreviewStore(data);
  const mapper = new GrokEventMapper("turn", data);

  const progress: SessionUpdate = {
    sessionUpdate: "tool_call",
    toolCallId: "capture",
    title: "use_tool",
    status: "in_progress",
    rawInput: { tool_name: "agent_browser__screenshot", tool_input: { format: "png" } },
    rawOutput: { content: [image] },
    content: [{ type: "content", content: { type: "image", data: png, mimeType: "image/png" } }],
  };

  const started = mapper.update(progress);

  expect(started[0]?.rawJson).toBe(JSON.stringify(progress));
  expect((await previews.enrich(started[0]!)).body?.case).toBe("itemStarted");

  const patch: SessionUpdate = {
    sessionUpdate: "tool_call_update",
    toolCallId: "capture",
    status: "completed",
  };

  const completionEvents = mapper.update(patch);

  expect(completionEvents).toHaveLength(2);
  expect(completionEvents[0]).toEqual({ turnId: "turn", rawJson: JSON.stringify(patch) });
  const completed = completionEvents[1]!;

  const enriched = await previews.enrich(completed);
  const body = enriched.body;

  if (body?.case !== "itemCompleted" || body.value.item?.content?.case !== "toolCall")
    throw new Error("Expected a completed Grok MCP item");
  const item = body.value.item;
  const images = body.value.item.content.value.images ?? [];
  const expected = Buffer.from(png, "base64");
  const sha256 = createHash("sha256").update(expected).digest("hex");

  expect(item.status).toBe(ItemStatus.COMPLETED);
  expect(images).toHaveLength(1);
  expect(images[0]).toMatchObject({ sha256, mimeType: "image/png", sizeBytes: BigInt(expected.length) });
  expect(readFileSync(join(data, "previews", sha256))).toEqual(expected);
  expect(inlineImages(completed.rawJson ?? "", "turn:another-call")).toEqual([]);
  const restarted = await new PreviewStore(data).enrich(completed);

  expect(restarted.body).toEqual(enriched.body);
});

test("Grok MCP raw output images are extracted from direct, enveloped and JSON string results", async () => {
  const data = temporary("canopy-grok-image-results-");
  const previews = new PreviewStore(data);

  for (const rawOutput of [
    { content: [image] },
    { result: { content: [image] } },
    JSON.stringify({ content: [image] }),
  ]) {
    const mapper = new GrokEventMapper("turn", data);

    mapper.update({
      sessionUpdate: "tool_call",
      toolCallId: "capture",
      rawInput: { tool_name: "agent_desktop__screenshot" },
      status: "in_progress",
    });

    const patch: SessionUpdate = {
      sessionUpdate: "tool_call_update",
      toolCallId: "capture",
      title: "agent_desktop__screenshot",
      status: "completed",
      rawOutput,
    };

    const completed = mapper.update(patch);

    expect(completed).toHaveLength(1);
    expect(completed[0]?.rawJson).toBe(JSON.stringify(patch));
    const event = completed[0]!;

    const enriched = await previews.enrich(event);
    const body = enriched.body;

    if (body?.case !== "itemCompleted" || body.value.item?.content?.case !== "toolCall")
      throw new Error("Expected a completed Grok MCP item");

    expect(body.value.item.content.value.images).toHaveLength(1);
  }
});

test("Grok malformed MCP image content leaves the completed tool usable and existing provider image formats work", async () => {
  const data = temporary("canopy-grok-image-malformed-");
  const mapper = new GrokEventMapper("turn", data);

  const event = mapper.update({
    sessionUpdate: "tool_call",
    toolCallId: "capture",
    title: "agent_device__screenshot",
    status: "completed",
    rawOutput: "invalid JSON",
    content: [
      { type: "content", content: { type: "text", text: "Screenshot unavailable" } },
      { type: "content", content: { type: "image", mimeType: "image/png", data: "invalid image" } },
    ],
  })[0]!;

  expect(await new PreviewStore(data).enrich(event)).toEqual(event);

  const rawEvents = [
    { result: { content: [image] } },
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "capture", content: [image] }] },
    },
    { params: { item: { id: "capture", result: { content: [image] } } } },
  ];

  for (const raw of rawEvents)
    expect(inlineImages(JSON.stringify(raw), "capture")).toEqual([{ mimeType: "image/png", base64: png }]);
});

test("startup retains old blobs referenced by unacked or held journal events and prunes them after ACK", async () => {
  const root = temporary("canopy-preview-pending-retention-");
  const store = new PreviewStore(root);
  const ref = store.put(Buffer.from(png, "base64"), "image/png");
  const orphan = store.put(Buffer.from("unreferenced"), "image/png");
  const old = new Date(Date.now() - 8 * 24 * 3600_000);
  const path = join(root, "previews", ref.sha256!);
  const orphanPath = join(root, "previews", orphan.sha256!);
  utimesSync(path, old, old);
  utimesSync(orphanPath, old, old);
  const runtime = ManagedRuntime.make(Journal.layer(join(root, "journal.db")));

  try {
    const event = await runtime.runPromise(
      Journal.use((journal) =>
        journal.append("thread", {
          body: {
            case: "itemCompleted",
            value: {
              item: {
                itemId: "cell",
                content: { case: "toolCall", value: { name: "exec", images: [ref] } },
              },
            },
          },
        }),
      ),
    );

    await runtime.runPromise(Journal.use((journal) => journal.holdPending()));
    const host = new WorkerHost({ runtime, dataDir: root, clientVersion: "test" });

    try {
      expect(existsSync(path)).toBe(true);
      await host.recover();
      expect(existsSync(path)).toBe(true);
      expect(existsSync(orphanPath)).toBe(false);
      await runtime.runPromise(Journal.use((journal) => journal.ack(event.threadId, event.journalSeq)));
      await host.recover();
      expect(existsSync(path)).toBe(false);
    } finally {
      await host.close();
    }
  } finally {
    await runtime.dispose();
  }
});

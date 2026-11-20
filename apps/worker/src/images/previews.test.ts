import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { tempDirs } from "@canopy/testing";
import { EventAckSchema, ItemStatus, WelcomeSchema } from "@canopy/contracts";
import { Effect, ManagedRuntime } from "effect";
import type { SessionUpdate } from "@canopy/grok-acp";
import { PreviewStore, inlineImages } from "./index.ts";
import { GrokEventMapper } from "../providers/grok/mapping.ts";
import { Journal, type ThreadEventInit } from "../journal/index.ts";
import { applyAck, resendPending, type GatewayLink } from "../gateway-link/index.ts";
import { WorkerHost } from "../runtime/host.ts";
import { HostState } from "../runtime/host-state.ts";
import { WorkerPreviewCleanup } from "../runtime/preview-cleanup.ts";

const temporary = tempDirs();
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const image = { type: "image", data: png, mimeType: "image/png" };

test("platform image previews only use completed tool output bytes, across all adapters", async () => {
  const data = temporary("canopy-scoped-image-preview-");
  const previews = new PreviewStore(data);
  const path = join(data, "existing.png");
  writeFileSync(path, Buffer.from(png, "base64"));

  const outputs = [
    { result: { content: [image] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "image", content: [image] }] } },
    {
      params: {
        item: { id: "image", contentItems: [{ type: "inputImage", imageUrl: `data:image/png;base64,${png}` }] },
      },
    },
  ];

  for (const output of outputs) {
    const event = {
      body: {
        case: "itemCompleted",
        value: { item: { itemId: "image", content: { case: "image", value: { path, source: "view_image" } } } },
      },
    } as const;

    const item = event.body.value.item;

    const denied = {
      ...event,
      body: { ...event.body, value: { item: { ...item, status: ItemStatus.FAILED } } },
    };

    const complete = {
      ...event,
      body: { ...event.body, value: { item: { ...item, status: ItemStatus.COMPLETED } } },
    };

    expect(await previews.enrich(denied)).toEqual(denied);
    expect(await previews.enrich(complete)).toEqual(complete);
    const success = await previews.enrich({ ...complete, rawJson: JSON.stringify(output) });

    expect(success.body).toMatchObject({
      value: { item: { content: { value: { blob: { mimeType: "image/png" } } } } },
    });
  }
});

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

test("cleanup retains a reused expired preview before append, then retains its journal ref until ACK", async () => {
  const dataDir = temporary("canopy-preview-inflight-retention-");
  const runtime = ManagedRuntime.make(Journal.layer(join(dataDir, "journal.db")));
  const state = new HostState({ runtime, dataDir, clientVersion: "test" });
  const cleanup = new WorkerPreviewCleanup(state);
  const bytes = Buffer.from(png, "base64");
  const ref = state.previews.put(bytes, "image/png");
  const orphan = state.previews.put(Buffer.from("unreferenced"), "image/png");
  const path = join(dataDir, "previews", ref.sha256);
  const orphanPath = join(dataDir, "previews", orphan.sha256);
  const old = new Date(Date.now() - 8 * 24 * 3600_000);
  utimesSync(path, old, old);
  utimesSync(orphanPath, old, old);

  const beforeAppend = Promise.withResolvers<ThreadEventInit>();
  const resume = Promise.withResolvers<void>();

  const recorded = runtime.runPromise(
    Journal.use((journal) =>
      state.previews.record(
        {
          body: {
            case: "itemCompleted",
            value: { item: { itemId: "image", content: { case: "toolCall", value: { name: "capture" } } } },
          },
          rawJson: JSON.stringify({ result: { content: [image] } }),
        },
        (enriched) =>
          Effect.gen(function* () {
            beforeAppend.resolve(enriched);
            yield* Effect.promise(() => resume.promise);

            return yield* journal.append("thread", enriched);
          }),
      ),
    ),
  );

  void recorded.catch(beforeAppend.reject);

  try {
    expect(await beforeAppend.promise).toMatchObject({
      body: { value: { item: { content: { value: { images: [ref] } } } } },
    });
    expect(await runtime.runPromise(Journal.use((journal) => journal.cursors()))).toEqual([]);
    await cleanup.start();
    expect(readFileSync(path)).toEqual(bytes);
    expect(existsSync(orphanPath)).toBe(false);

    resume.resolve();
    const event = await recorded;
    await cleanup.sweep();
    expect(readFileSync(path)).toEqual(bytes);
    await runtime.runPromise(applyAck(create(EventAckSchema, { threadId: event.threadId, ackSeq: event.journalSeq })));
    await cleanup.sweep();
    expect(existsSync(path)).toBe(false);
  } finally {
    resume.resolve();
    await recorded.catch(() => {});
    await cleanup.stop();
    await runtime.dispose();
  }
});

test("held refs survive restart and replay until every event referencing the hash is acknowledged", async () => {
  const root = temporary("canopy-preview-pending-retention-");
  const store = new PreviewStore(root);
  const bytes = Buffer.from(png, "base64");
  const ref = store.put(bytes, "image/png");
  const old = new Date(Date.now() - 8 * 24 * 3600_000);
  const file = join(root, "previews", ref.sha256);
  utimesSync(file, old, old);
  const journalPath = join(root, "journal.db");
  const runtime = ManagedRuntime.make(Journal.layer(journalPath));

  const init: ThreadEventInit = {
    body: {
      case: "itemCompleted",
      value: { item: { itemId: "cell", content: { case: "toolCall", value: { name: "exec", images: [ref] } } } },
    },
  };

  const first = await runtime
    .runPromise(
      Journal.use((journal) =>
        Effect.gen(function* () {
          const event = yield* journal.append("first", init);
          yield* journal.append("second", init);
          yield* journal.holdPending();

          return event;
        }),
      ),
    )
    .finally(() => runtime.dispose());

  const reopened = ManagedRuntime.make(Journal.layer(journalPath));
  const host = new WorkerHost({ runtime: reopened, dataDir: root, clientVersion: "test" });
  const sent: Parameters<GatewayLink["send"]>[0][] = [];

  const link: GatewayLink = {
    welcome: create(WelcomeSchema, { isolatedEventIngest: true }),
    messages: { async *[Symbol.asyncIterator]() {} },
    closed: Promise.resolve({}),
    close: () => {},
    send: (payload) => sent.push(payload),
  };

  try {
    expect((await reopened.runPromise(Journal.use((journal) => journal.heldThreads()))).sort()).toEqual([
      "first",
      "second",
    ]);
    await host.recover();
    expect(readFileSync(file)).toEqual(bytes);
    await reopened.runPromise(applyAck(create(EventAckSchema, { threadId: first.threadId, ackSeq: first.journalSeq })));
    await host.recover();
    expect(readFileSync(file)).toEqual(bytes);
    expect(await reopened.runPromise(resendPending(link, (event) => host.sendPreviews(link, event)))).toBe(1);
    expect(sent).toEqual([
      {
        case: "blobChunk",
        value: { threadId: "second", sha256: ref.sha256, offset: 0n, data: bytes, last: true, mimeType: "image/png" },
      },
      { case: "threadEvent", value: expect.objectContaining({ threadId: "second", journalSeq: 1n }) },
    ]);

    const welcome = create(WelcomeSchema, {
      isolatedEventIngest: true,
      persisted: [{ threadId: "second", lastSeq: 1n }],
    });

    expect(
      await reopened.runPromise(resendPending({ ...link, welcome }, (event) => host.sendPreviews(link, event))),
    ).toBe(0);
    await host.recover();
    expect(existsSync(file)).toBe(false);
  } finally {
    await host.close();
    await reopened.dispose();
  }
});

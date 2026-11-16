import { expect, test } from "bun:test";
import { createHash, randomFillSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  InteractionResponseSchema,
  PermissionMode,
  Provider,
  ThreadSpecSchema,
  UserInputSchema,
  WelcomeSchema,
  type Item,
  type ThreadEvent,
} from "@canopy/contracts";
import { eventItemId, previewRefs, reduceItem, type JsonObject } from "@canopy/domain";
import { tempDirs } from "@canopy/testing";
import { Effect, Layer } from "effect";
import sharp from "sharp";
import type { GatewayLink } from "../../gateway-link/index.ts";
import { PreviewStore, inlineImages } from "../../images/index.ts";
import { Journal } from "../../journal/index.ts";
import { decodeJsonObject, jsonObject } from "../json.ts";
import { resolveProfiles } from "../profiles.ts";
import { CodexThreads } from "./threads.ts";

const temporary = tempDirs();

function projection(events: readonly ThreadEvent[]) {
  const items = new Map<string, Item>();

  for (const event of events) {
    const id = eventItemId(event.body);

    if (!id) continue;
    const next = reduceItem(items.get(id), event.body);

    if (next) items.set(id, next);
  }

  return items;
}

function newLink(): GatewayLink {
  return {
    welcome: create(WelcomeSchema),
    messages: { async *[Symbol.asyncIterator]() {} },
    closed: Promise.resolve({}),
    send: () => {},
    close: () => {},
  };
}

test("code-mode rollout images persist before raw compaction, retain all outputs, and replay after restart", async () => {
  const root = temporary("canopy-codex-code-images-");
  const imagePath = join(root, "source.png");

  // Above the normal preview re-encoding threshold: the audit blob must still be the exact original image.
  const data = await sharp(randomFillSync(Buffer.alloc(1200 * 1200 * 3)), {
    raw: { width: 1200, height: 1200, channels: 3 },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();

  writeFileSync(imagePath, data);
  const sha256 = createHash("sha256").update(data).digest("hex");

  const secondData = await sharp(randomFillSync(Buffer.alloc(32 * 32 * 3)), {
    raw: { width: 32, height: 32, channels: 3 },
  })
    .png()
    .toBuffer();

  const secondPath = join(root, "second.png");
  writeFileSync(secondPath, secondData);
  const secondSha256 = createHash("sha256").update(secondData).digest("hex");

  const expectedBytes = new Map([
    [sha256, data],
    [secondSha256, secondData],
  ]);

  const profile = resolveProfiles([{ id: "native", kind: "native", providers: ["codex"] }])[0]!.resolved!;
  const published: ThreadEvent[] = [];
  const previews = new PreviewStore(root);
  const rawBefore: string[] = [];
  const threadId = Bun.randomUUIDv7();
  const journalPath = join(root, "journal.db");
  const rolloutPath = join(root, "rollout.jsonl");

  const layer = CodexThreads.layer({
    launch: {
      command: [process.execPath, join(import.meta.dir, "fixtures/code-mode-images.ts")],
      env: { CANOPY_TEST_ROLLOUT: rolloutPath, CANOPY_TEST_IMAGE: imagePath, CANOPY_TEST_SECOND_IMAGE: secondPath },
    },
    clientVersion: "test",
    profile: () => profile,
    publish: (event) => published.push(event),
    interact: async () => create(InteractionResponseSchema, { allow: false }),
    callTool: async () => create(AgentToolResultSchema, { isError: true }),
    enrich: async (init) => {
      rawBefore.push(init.rawJson ?? "");
      const enriched = await previews.enrich(init);

      const body = enriched.body;

      if (
        enriched.rawJson !== init.rawJson &&
        body?.case === "itemCompleted" &&
        body.value.item?.content?.case === "toolCall"
      )
        for (const ref of body.value.item.content.value.images ?? [])
          expect(readFileSync(join(root, "previews", ref.sha256!))).toEqual(expectedBytes.get(ref.sha256!)!);

      return enriched;
    },
  }).pipe(Layer.provideMerge(Journal.layer(journalPath)));

  const pending = await Effect.runPromise(
    Effect.gen(function* () {
      const threads = yield* CodexThreads;
      const journal = yield* Journal;

      const spec = create(ThreadSpecSchema, {
        threadId,
        cwd: root,
        provider: Provider.CODEX,
        providerProfileId: "native",
        permissionMode: PermissionMode.ASK,
      });

      yield* threads.create(spec);
      yield* threads.startTurn(spec, Bun.randomUUIDv7(), create(UserInputSchema, { text: "Inspect images" }));

      while (!published.some((event) => event.body.case === "turnFinished")) yield* Effect.sleep("5 millis");

      return yield* journal.pending(new Map());
    }).pipe(Effect.timeout("10 seconds"), Effect.provide(layer), Effect.scoped),
  );

  expect(pending).toEqual(published);
  const items = projection(pending);
  const cell = items.get("cell")!;
  const wait = items.get("wait-cell")!;
  expect(cell.content).toMatchObject({
    case: "toolCall",
    value: {
      inputJson: JSON.stringify({ code: "image(result)" }),
      output: "before\n\n[input_image]\n[input_image]\nafter\n\nnext image\n[input_image]\nfinished\n",
      images: [
        { sha256, mimeType: "image/png", sizeBytes: BigInt(data.length) },
        { sha256: secondSha256, mimeType: "image/png", sizeBytes: BigInt(secondData.length) },
      ],
    },
  });
  expect(previewRefs(wait)).toEqual([previewRefs(cell)[0]!]);
  const unmapped = pending.find((event) => event.rawJson.includes('"thread/readState/changed"'))!;
  expect(unmapped.body.case).toBeUndefined();
  expect(rawBefore).toContain(unmapped.rawJson);
  expect(unmapped.rawJson).toContain(secondData.toString("base64"));
  const original = rawBefore.find((raw) => raw.includes('"provider-output-id"'))!;
  const enriched = pending.find((event) => event.rawJson.includes('"provider-output-id"'))!;
  expect(enriched.rawJson.length).toBeLessThan(original.length / 100);
  expect(inlineImages(original, "cell")).toEqual([{ mimeType: "image/png", base64: data.toString("base64") }]);
  expect(inlineImages(original, "provider-output-id")).toEqual([]);
  expect(inlineImages(original, "another-cell")).toEqual([]);

  const raw = decodeJsonObject(JSON.parse(enriched.rawJson));
  const params = jsonObject(raw["params"])!;
  const item = jsonObject(params["item"])!;
  const output = item["output"];

  if (!Array.isArray(output)) throw new Error("Expected output blocks");

  const restored = output.map((block) => {
    const value = jsonObject(block);
    const url = jsonObject(value?.["image_url"]);

    if (!url || !value) return block;
    expect(url).toEqual({
      canopyBlob: { sha256, mimeType: "image/png", sizeBytes: String(data.length) },
      dataUrlPrefix: "data:image/png;base64,",
    });

    return { ...value, image_url: `${url["dataUrlPrefix"]}${data.toString("base64")}` };
  });

  expect({ ...raw, params: { ...params, item: { ...item, output: restored } } }).toEqual(JSON.parse(original));

  const replayed = await Effect.runPromise(
    Journal.use((journal) => journal.pending(new Map())).pipe(
      Effect.provide(Journal.layer(journalPath)),
      Effect.scoped,
    ),
  );

  expect(replayed).toEqual(pending);
  const restarted = new PreviewStore(root);
  const link = newLink();
  const uploads = new Map<string, Uint8Array[]>();

  for (const event of replayed)
    restarted.sendFor(link, event, (chunk) => {
      const chunks = uploads.get(chunk.sha256) ?? [];
      chunks.push(chunk.data);
      uploads.set(chunk.sha256, chunks);
    });
  expect(uploads.size).toBe(2);

  for (const [sha, chunks] of uploads) expect(Buffer.concat(chunks)).toEqual(expectedBytes.get(sha)!);
  expect(uploads.get(sha256)!.length).toBeGreaterThan(1);
  // The same hash must still upload when another thread uses it, even over the same connection.
  const otherThread: ThreadEvent = { ...enriched, threadId: Bun.randomUUIDv7() };
  const otherChunks: Uint8Array[] = [];
  restarted.sendFor(link, otherThread, (chunk) => otherChunks.push(chunk.data));
  expect(Buffer.concat(otherChunks)).toEqual(data);
  expect(await restarted.enrich(enriched)).toEqual(enriched);

  // This test's inputs are synthetic; no existing harness rollout or production row was changed.
  const lines = readFileSync(rolloutPath, "utf8").trim().split("\n");
  const payloads: JsonObject[] = lines.map((line) => decodeJsonObject(JSON.parse(line)));
  expect(payloads.some((line) => JSON.stringify(line).includes(data.toString("base64")))).toBe(true);
}, 20_000);

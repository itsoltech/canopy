import { expect, test } from "bun:test";
import { randomFillSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ItemStatus, ThreadEventSchema, type BlobRef } from "@canopy/contracts";
import type { JsonValue } from "@canopy/domain";
import { tempDirs } from "@canopy/testing";
import sharp from "sharp";
import type { ThreadEventInit } from "../journal/index.ts";
import { compactCodexOutput, codexOutputImages } from "./codex-output.ts";
import { PreviewStore } from "./previews.ts";

const temporary = tempDirs();

function event(output: JsonValue, callId = "cell") {
  return {
    turnId: "turn",
    rawJson: JSON.stringify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "provider-thread",
        turnId: "provider-turn",
        item: { type: "custom_tool_call_output", call_id: callId, output },
      },
      future: { preserve: ["audit", 42] },
    }),
    body: {
      case: "itemCompleted",
      value: {
        item: {
          itemId: "cell",
          status: ItemStatus.COMPLETED,
          content: { case: "toolCall", value: { name: "exec", output: "result" } },
        },
      },
    },
  } satisfies ThreadEventInit;
}

async function image() {
  const data = await sharp(randomFillSync(Buffer.alloc(32 * 32 * 3)), {
    raw: { width: 32, height: 32, channels: 3 },
  })
    .png()
    .toBuffer();

  return { data, block: { type: "input_image", image_url: `data:image/png;base64,${data.toString("base64")}` } };
}

function images(init: ThreadEventInit): BlobRef[] {
  const event = create(ThreadEventSchema, { body: init.body ?? { case: undefined } });
  const body = event.body;

  if (body.case !== "itemCompleted" || body.value.item?.content.case !== "toolCall")
    throw new Error("Expected tool output");

  return body.value.item.content.value.images;
}

test("compaction requires exact durable refs and leaves text, unknown and malformed blocks untouched", async () => {
  const root = temporary("canopy-codex-raw-images-");
  const store = new PreviewStore(root);
  const { data, block } = await image();

  const others = [
    { type: "input_text", text: "text with data:image/png;base64,keep-this" },
    { type: "input_audio", audio_url: "data:audio/wav;base64,AAAA" },
    { type: "encrypted_content", encrypted_content: "opaque" },
    { type: "future_image", image_url: block.image_url, opaque: { image: block } },
    { type: "input_image", file_id: "external-file", detail: "high" },
    { type: "input_image", image_url: "https://example.invalid/capture.png" },
    { type: "input_image", image_url: "data:image/png;base64,broken==" },
    { type: "input_image", image_url: "data:image/png;base64,YQ==" },
  ];

  const init = event([block, ...others]);
  expect(compactCodexOutput(init.rawJson!, "cell", [])).toBe(init.rawJson);
  const enriched = await store.enrich(init);
  const refs = images(enriched);
  expect(refs).toHaveLength(1);
  expect(readFileSync(join(root, "previews", refs[0]!.sha256))).toEqual(data);
  expect(JSON.parse(enriched.rawJson!)).toEqual({
    method: "rawResponseItem/completed",
    params: {
      threadId: "provider-thread",
      turnId: "provider-turn",
      item: {
        type: "custom_tool_call_output",
        call_id: "cell",
        output: [
          {
            type: "input_image",
            image_url: {
              canopyBlob: { sha256: refs[0]!.sha256, mimeType: "image/png", sizeBytes: String(data.length) },
              dataUrlPrefix: "data:image/png;base64,",
            },
          },
          ...others,
        ],
      },
    },
    future: { preserve: ["audit", 42] },
  });
  expect(init.rawJson).toContain(block.image_url);
  expect(images(init)).toEqual([]);

  for (const ref of [
    { ...refs[0]!, sha256: "0".repeat(64) },
    { ...refs[0]!, mimeType: "image/jpeg" },
    { ...refs[0]!, sizeBytes: BigInt(data.length + 1) },
  ])
    expect(compactCodexOutput(init.rawJson!, "cell", [ref])).toBe(init.rawJson);
});

test("failed storage, missing mapping, and transport-ineligible images keep their original raw data", async () => {
  const root = temporary("canopy-codex-raw-fallback-");
  const store = new PreviewStore(root);
  const { block } = await image();
  const init = event([block]);

  const failed = await codexOutputImages(init, () => {
    throw new Error("fixture disk unavailable");
  });

  expect(failed?.rawJson).toBe(init.rawJson);
  expect(images(failed!)).toEqual([]);
  const mismatched = event([block], "other-cell");
  expect(await store.enrich(mismatched)).toEqual(mismatched);
  const unmapped = { turnId: init.turnId, rawJson: init.rawJson };
  expect(await store.enrich(unmapped)).toEqual(unmapped);
  const noncanonical = { ...block, image_url: `${block.image_url}\n` };
  const unsupported = { ...block, image_url: block.image_url.replace("image/png", "image/tiff") };

  const oversized = {
    type: "input_image",
    image_url: `data:image/png;base64,${Buffer.alloc(8 * 1024 ** 2 + 1).toString("base64")}`,
  };

  for (const output of ["result", [noncanonical], [unsupported], [oversized]]) {
    const original = event(output);
    const enriched = await store.enrich(original);
    expect(enriched.rawJson).toBe(original.rawJson);
    expect(images(enriched)).toEqual([]);
  }
});

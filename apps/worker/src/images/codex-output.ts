import { createHash } from "node:crypto";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { BlobRefSchema, ItemSchema, type BlobRef } from "@canopy/contracts";
import { INLINE_IMAGE_TYPES, type JsonObject, type JsonValue } from "@canopy/domain";
import sharp from "sharp";
import type { ThreadEventInit } from "../journal/index.ts";
import { decodeJsonObject, isString, jsonObject } from "../providers/json.ts";

// Existing worker → gateway preview transport cap (docs/protocol.md, Załączniki).
const MAX_IMAGE_BYTES = 8 * 1024 ** 2;

type Put = (data: Uint8Array, mimeType: string) => MessageInitShape<typeof BlobRefSchema>;

function outputOf(rawJson: string, itemId: string) {
  let raw: JsonObject;

  try {
    raw = decodeJsonObject(JSON.parse(rawJson));
  } catch {
    return undefined;
  }

  const params = jsonObject(raw["params"]);
  const item = jsonObject(params?.["item"]);

  if (
    raw["method"] !== "rawResponseItem/completed" ||
    !item ||
    item["call_id"] !== itemId ||
    (item["type"] !== "custom_tool_call_output" && item["type"] !== "function_call_output") ||
    !Array.isArray(item["output"])
  )
    return undefined;

  return { raw, params, item, output: item["output"] };
}

function imageSource(value: JsonValue) {
  const block = jsonObject(value);
  const url = block?.["image_url"];

  if (block?.["type"] !== "input_image" || !isString(url)) return undefined;
  const match = /^(data:([^;,]+);base64,)([A-Za-z0-9+/]*={0,2})$/.exec(url);

  if (!match || !INLINE_IMAGE_TYPES.has(match[2]!) || match[3]!.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
    return undefined;
  const data = Buffer.from(match[3]!, "base64");

  // Only canonical base64 can be reconstructed exactly from the stored bytes and prefix.
  if (!data.length || data.length > MAX_IMAGE_BYTES || data.toString("base64") !== match[3]) return undefined;

  return { block, data, prefix: match[1]!, mimeType: match[2]! };
}

/** Pure raw rewrite: only exact image bytes already represented by this item's durable refs may move out. */
export function compactCodexOutput(rawJson: string, itemId: string, refs: readonly BlobRef[]): string {
  const source = outputOf(rawJson, itemId);

  if (!source) return rawJson;
  let changed = false;

  const output = source.output.map((value) => {
    const image = imageSource(value);

    if (!image) return value;
    const sha256 = createHash("sha256").update(image.data).digest("hex");

    const ref = refs.find(
      (ref) => ref.sha256 === sha256 && ref.mimeType === image.mimeType && ref.sizeBytes === BigInt(image.data.length),
    );

    if (!ref) return value;
    changed = true;

    return {
      ...image.block,
      image_url: {
        canopyBlob: { sha256, sizeBytes: ref.sizeBytes.toString(), mimeType: ref.mimeType },
        dataUrlPrefix: image.prefix,
      },
    };
  });

  if (!changed) return rawJson;

  const compacted = JSON.stringify({
    ...source.raw,
    params: { ...source.params, item: { ...source.item, output } },
  });

  return compacted.length < rawJson.length ? compacted : rawJson;
}

/** Save original code-mode image bytes first; previews alone may be lossy and cannot replace audit data. */
export async function codexOutputImages(init: ThreadEventInit, put: Put): Promise<ThreadEventInit | undefined> {
  const body = init.body;

  if (body?.case !== "itemCompleted" || body.value.item?.content?.case !== "toolCall") return undefined;
  const item = create(ItemSchema, body.value.item);
  const source = outputOf(init.rawJson ?? "", item.itemId);

  if (!source || item.content.case !== "toolCall") return undefined;
  const images = item.content.value.images;

  for (const block of source.output) {
    const image = imageSource(block);

    if (!image) continue;

    try {
      const metadata = await sharp(image.data).metadata();

      if (!metadata.width || !metadata.height) continue;
      const ref = create(BlobRefSchema, put(image.data, image.mimeType));

      if (!images.some((previous) => previous.sha256 === ref.sha256)) images.push(ref);
    } catch {
      // A failed decode or write retains the original raw payload, including its image bytes.
    }
  }

  return {
    ...init,
    rawJson: compactCodexOutput(init.rawJson ?? "", item.itemId, images),
    body: { case: "itemCompleted", value: { ...body.value, item } },
  };
}

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { BlobRefSchema, ItemSchema, type ThreadEvent } from "@open-agents/contracts";
import { INLINE_IMAGE_TYPES, previewRefs } from "@open-agents/domain";
import sharp from "sharp";
import type { ThreadEventInit } from "../journal/index.ts";
import { forTranscript, MAX_SOURCE_BYTES } from "./normalize.ts";
import { readLimited } from "./view-image.ts";

/**
 * What the agent looked at, for the transcript (docs/transcript.md, "Obrazy"): every image a model saw becomes a
 * preview blob the item points to (Image.blob for view_image and Codex's own view_image, ToolCall.images for image
 * results of other tools, e.g. Claude's Read on an image file or an MCP tool).
 *
 * - Previews are files in `<data_dir>/previews/<sha256>`, written before the event is journaled, so a resend after
 *   a reconnect or restart still has them. They are sent (BlobChunk) right before the first event that points to
 *   them on each link; the gateway stores each content once.
 * - An image the model got inline (base64 in the tool result) is shown as it is when it is small enough; an image
 *   known only by its path is read (at most 50 MB) and scaled to a WebP preview.
 * - Nothing here fails an event: without a preview the item is journaled as it came.
 */

type BlobRefInit = MessageInitShape<typeof BlobRefSchema>;
type ItemInit = MessageInitShape<typeof ItemSchema>;

const CHUNK_BYTES = 256 * 1024;
/** An inline image larger than this is re-encoded for the transcript. */
const MAX_INLINE_PREVIEW = 4 * 1024 ** 2;
/** Previews older than this are removed at start (the gateway has them once their events are acked). */
const KEEP_MS = 7 * 24 * 3600_000;

export class PreviewStore {
  readonly #dir: string;
  /** Previews already sent on a link (the same image shown twice goes once). */
  readonly #sent = new WeakMap<object, Set<string>>();

  constructor(dataDir: string) {
    this.#dir = join(dataDir, "previews");
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
  }

  /** Removes old previews; returns how many. */
  prune(now = Date.now()): number {
    let removed = 0;
    for (const name of readdirSync(this.#dir)) {
      const path = join(this.#dir, name);
      try {
        if (now - statSync(path).mtimeMs > KEEP_MS) {
          unlinkSync(path);
          removed++;
        }
      } catch {
        // gone meanwhile
      }
    }
    return removed;
  }

  put(data: Uint8Array, mimeType: string): BlobRefInit {
    const sha256 = createHash("sha256").update(data).digest("hex");
    const path = join(this.#dir, sha256);
    if (!existsSync(path)) {
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, data, { mode: 0o600 });
      renameSync(tmp, path);
    }
    return { sha256, sizeBytes: BigInt(data.length), mimeType };
  }

  /** Sends the previews an event points to over `link` (once per link), before the event itself. */
  sendFor(link: object, event: ThreadEvent, send: (chunk: { sha256: string; offset: bigint; data: Uint8Array; last: boolean; mimeType: string }) => void): void {
    const body = event.body;
    if (body.case !== "itemStarted" && body.case !== "itemCompleted") return;
    const item = body.value.item;
    if (!item) return;
    const sent = this.#sent.get(link) ?? new Set<string>();
    this.#sent.set(link, sent);
    for (const ref of previewRefs(item)) {
      if (sent.has(ref.sha256)) continue;
      let data: Uint8Array;
      try {
        data = readFileSync(join(this.#dir, ref.sha256));
      } catch {
        continue; // pruned or lost: the UI says the preview is not available
      }
      for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
        const end = Math.min(offset + CHUNK_BYTES, data.length);
        send({ sha256: ref.sha256, offset: BigInt(offset), data: data.subarray(offset, end), last: end === data.length, mimeType: ref.mimeType });
      }
      sent.add(ref.sha256);
    }
  }

  /**
   * Adds previews to a completed image or tool item: the images in its raw provider event (inline), else the file
   * at the image's path. Returns the event unchanged when there is nothing to show.
   */
  async enrich(init: ThreadEventInit): Promise<ThreadEventInit> {
    const body = init.body;
    if (body?.case !== "itemCompleted" || !body.value.item) return init;
    const kind = body.value.item.content?.case;
    if (kind !== "image" && kind !== "toolCall") return init;
    const item = create(ItemSchema, body.value.item as ItemInit);
    const done = () => ({ ...init, body: { case: "itemCompleted" as const, value: { item } } });
    try {
      if (item.content.case === "image" && !item.content.value.blob) {
        const image = item.content.value;
        const inline = inlineImages(init.rawJson ?? "", item.itemId)[0];
        const preview = inline ? await this.#inline(inline) : image.path ? await this.#file(image.path) : undefined;
        if (!preview) return init;
        image.blob = create(BlobRefSchema, preview.ref);
        image.width = preview.width ?? 0;
        image.height = preview.height ?? 0;
        if (preview.originalWidth) {
          image.originalWidth = preview.originalWidth;
          image.originalHeight = preview.originalHeight ?? 0;
        }
        return done();
      }
      if (item.content.case === "toolCall" && item.content.value.images.length === 0) {
        const inline = inlineImages(init.rawJson ?? "", item.itemId);
        if (inline.length === 0) return init;
        for (const image of inline.slice(0, 8)) {
          const preview = await this.#inline(image).catch(() => undefined);
          if (preview) item.content.value.images.push(create(BlobRefSchema, preview.ref));
        }
        return item.content.value.images.length > 0 ? done() : init;
      }
    } catch {
      return init; // no preview: the item as the provider reported it
    }
    return init;
  }

  async #inline(image: InlineImage): Promise<{ ref: BlobRefInit; width?: number; height?: number; originalWidth?: number; originalHeight?: number }> {
    const data = Buffer.from(image.base64, "base64");
    if (INLINE_IMAGE_TYPES.has(image.mimeType) && image.mimeType !== "image/gif" && data.length <= MAX_INLINE_PREVIEW) {
      // Exactly what the model saw.
      const { width, height } = await sharp(data).metadata();
      return { ref: this.put(new Uint8Array(data), image.mimeType), ...(width && height && { width, height }) };
    }
    const preview = await forTranscript(new Uint8Array(data));
    return { ref: this.put(preview.data, preview.mimeType), width: preview.width, height: preview.height };
  }

  async #file(path: string) {
    const preview = await forTranscript(readLimited(path, MAX_SOURCE_BYTES));
    return { ref: this.put(preview.data, preview.mimeType), width: preview.width, height: preview.height, originalWidth: preview.originalWidth, originalHeight: preview.originalHeight };
  }
}

interface InlineImage {
  readonly mimeType: string;
  readonly base64: string;
}

/**
 * Images a provider event carries for one item:
 * - Claude: tool_result blocks (tool_use_id = item id) with image blocks `{source: {type: "base64", media_type, data}}`,
 * - Codex dynamic tools (view_image): `contentItems: [{type: "inputImage", imageUrl: "data:...;base64,..."}]`,
 * - Codex MCP tools: `result.content: [{type: "image", data, mimeType}]`.
 */
export function inlineImages(rawJson: string, itemId: string): InlineImage[] {
  if (!rawJson || !rawJson.includes("image")) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(rawJson);
  } catch {
    return [];
  }
  const out: InlineImage[] = [];
  const fromBlock = (block: unknown) => {
    if (!block || typeof block !== "object") return;
    const b = block as Record<string, unknown>;
    const source = b["source"] as Record<string, unknown> | undefined;
    if (b["type"] === "image" && source?.["type"] === "base64" && typeof source["data"] === "string") {
      out.push({ mimeType: String(source["media_type"] ?? "image/png"), base64: source["data"] });
    } else if (b["type"] === "image" && typeof b["data"] === "string") {
      out.push({ mimeType: String(b["mimeType"] ?? "image/png"), base64: b["data"] });
    } else if (b["type"] === "inputImage" && typeof b["imageUrl"] === "string") {
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(b["imageUrl"]);
      if (match) out.push({ mimeType: match[1]!, base64: match[2]! });
    }
  };
  const r = raw as Record<string, unknown>;
  // Claude: a user message with tool results.
  const message = r["message"] as { content?: unknown } | undefined;
  if (r["type"] === "user" && Array.isArray(message?.content)) {
    for (const block of message.content as Record<string, unknown>[]) {
      if (block["type"] !== "tool_result" || block["tool_use_id"] !== itemId || !Array.isArray(block["content"])) continue;
      for (const inner of block["content"] as unknown[]) fromBlock(inner);
    }
    return out;
  }
  // Codex: item/completed.
  const item = (r["params"] as { item?: Record<string, unknown> } | undefined)?.item;
  if (item && item["id"] === itemId) {
    if (Array.isArray(item["contentItems"])) for (const c of item["contentItems"] as unknown[]) fromBlock(c);
    const result = item["result"] as { content?: unknown } | null | undefined;
    if (Array.isArray(result?.content)) for (const c of result.content as unknown[]) fromBlock(c);
  }
  return out;
}

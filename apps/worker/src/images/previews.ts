import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { BlobRefSchema, ItemSchema, ItemStatus, type BlobRef, type ThreadEvent } from "@canopy/contracts";
import { INLINE_IMAGE_TYPES, previewRefs, type JsonValue, type JsonObject } from "@canopy/domain";
import { Effect } from "effect";
import { decodeJsonObject, isString, jsonObject } from "../providers/json.ts";
import type { GatewayLink } from "../gateway-link/index.ts";
import sharp from "sharp";
import type { JournalError, ThreadEventInit } from "../journal/index.ts";
import { forTranscript } from "./normalize.ts";
import { readScopedImage, type ViewImageScope } from "./view-image.ts";
import { codexOutputImages } from "./codex-output.ts";
import { expiredPreviews, removeExpiredPreviews } from "./preview-retention.ts";

/**
 * What the agent looked at, for the transcript (docs/transcript.md, "Obrazy"): every image a model saw becomes a
 * preview blob the item points to (Image.blob for view_image and Codex's own view_image, ToolCall.images for image
 * results of other tools, e.g. Claude's Read on an image file or an MCP tool).
 *
 * - Previews are files in `<data_dir>/previews/<sha256>`, written before the event is journaled, so a resend after
 *   a reconnect or restart still has them. They are sent (BlobChunk) right before the first event that points to
 *   them on each link; the gateway stores each content once.
 * - An image the model got inline (base64 in the tool result) is shown as it is when it is small enough; an image
 *   emitted as a successful native Codex image can use a worker-verified path.
 * - Nothing here fails an event: without a preview the item is journaled as it came.
 */

type BlobRefInit = Pick<BlobRef, "sha256" | "sizeBytes" | "mimeType">;

type PutPreview = (data: Uint8Array, mimeType: string) => BlobRefInit;

const CHUNK_BYTES = 256 * 1024;

/** An inline image larger than this is re-encoded for the transcript. */
const MAX_INLINE_PREVIEW = 4 * 1024 ** 2;

type CodexPreviewScope = { native: ViewImageScope; generated: ViewImageScope };

/** A native or generated image may be read only inside the scope of its own kind. */
function previewScope(source: string, scope: CodexPreviewScope | undefined): ViewImageScope | undefined {
  switch (source) {
    case "native":
      return scope?.native;
    case "generated":
      return scope?.generated;
    default:
      return undefined;
  }
}

export class PreviewStore {
  readonly #dir: string;
  readonly #recording = new Set<Set<string>>();
  /** Previews already sent on a link (the same image shown twice goes once). */
  readonly #sent = new WeakMap<object, Set<string>>();

  constructor(dataDir: string) {
    this.#dir = join(dataDir, "previews");
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
  }

  /** Lists candidates asynchronously, then checks journal and in-flight refs in the same turn as deletion. */
  async prune(
    withPending: (prune: (pending: ReadonlySet<string>) => void) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const now = Date.now();
    const candidates = await expiredPreviews(this.#dir, now, signal);

    if (signal.aborted || candidates.length === 0) return;

    await withPending((pending) => {
      if (signal.aborted) return;
      const retained = new Set(pending);

      for (const recording of this.#recording) for (const hash of recording) retained.add(hash);

      removeExpiredPreviews(this.#dir, candidates, retained, now);
    });
  }

  /** Keeps reused and freshly written files alive until the local append has committed. */
  record(
    init: ThreadEventInit,
    append: (event: ThreadEventInit) => Effect.Effect<ThreadEvent, JournalError>,
    codexScope?: CodexPreviewScope,
  ): Effect.Effect<ThreadEvent, JournalError> {
    const body = init.body;

    if ((body?.case !== "itemStarted" && body?.case !== "itemCompleted") || !body.value.item) return append(init);
    const item = body.value.item;

    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const hashes = new Set(previewRefs(create(ItemSchema, item)).map((ref) => ref.sha256));
        this.#recording.add(hashes);

        return hashes;
      }),
      (hashes) =>
        Effect.promise(() => this.#enrich(init, codexScope, (data, mimeType) => this.put(data, mimeType, hashes))).pipe(
          Effect.flatMap(append),
        ),
      (hashes) => Effect.sync(() => void this.#recording.delete(hashes)),
    );
  }

  put(data: Uint8Array, mimeType: string, recording?: Set<string>): BlobRefInit {
    const sha256 = createHash("sha256").update(data).digest("hex");
    recording?.add(sha256);
    const path = join(this.#dir, sha256);

    if (!existsSync(path)) {
      const tmp = `${path}.${process.pid}.tmp`;
      const fd = openSync(tmp, "w", 0o600);

      try {
        writeFileSync(fd, data);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }

      renameSync(tmp, path);

      // POSIX persists the directory entry separately; Windows does not support opening a directory for fsync.
      if (process.platform !== "win32") {
        const directory = openSync(this.#dir, "r");

        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
      }
    }

    return { sha256, sizeBytes: BigInt(data.length), mimeType };
  }

  /** Sends the previews an event points to over `link` (once per link), before the event itself. */
  sendFor(
    link: GatewayLink,
    event: ThreadEvent,
    send: (chunk: { sha256: string; offset: bigint; data: Uint8Array; last: boolean; mimeType: string }) => void,
  ): void {
    const body = event.body;

    if (body.case !== "itemStarted" && body.case !== "itemCompleted") return;
    const item = body.value.item;

    if (!item) return;
    const sent = this.#sent.get(link) ?? new Set<string>();
    this.#sent.set(link, sent);

    for (const ref of previewRefs(item)) {
      const key = `${event.threadId}:${ref.sha256}`;

      if (sent.has(key)) continue;
      let data: Uint8Array;

      try {
        data = readFileSync(join(this.#dir, ref.sha256));
      } catch {
        continue; // pruned or lost: the UI says the preview is not available
      }

      for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
        const end = Math.min(offset + CHUNK_BYTES, data.length);
        send({
          sha256: ref.sha256,
          offset: BigInt(offset),
          data: data.subarray(offset, end),
          last: end === data.length,
          mimeType: ref.mimeType,
        });
      }

      sent.add(key);
    }
  }

  /**
   * Platform tools provide their own authorized image bytes. Only native Codex image events can use a scoped path.
   */
  async enrich(init: ThreadEventInit, codexScope?: CodexPreviewScope): Promise<ThreadEventInit> {
    return this.#enrich(init, codexScope, (data, mimeType) => this.put(data, mimeType));
  }

  async #enrich(init: ThreadEventInit, codexScope: CodexPreviewScope | undefined, put: PutPreview) {
    const body = init.body;

    if (body?.case !== "itemCompleted" || !body.value.item) return init;
    const codex = await codexOutputImages(init, put);

    if (codex) return codex;
    const kind = body.value.item.content?.case;

    if (kind !== "image" && kind !== "toolCall") return init;
    const item = create(ItemSchema, body.value.item);
    const done = () => ({ ...init, body: { case: "itemCompleted" as const, value: { item } } });

    try {
      if (item.content.case === "image" && !item.content.value.blob) {
        if (item.status !== ItemStatus.COMPLETED) return init;
        const image = item.content.value;
        const inline = inlineImages(init.rawJson ?? "", item.itemId)[0];
        const scope = previewScope(image.source, codexScope);

        const preview = inline
          ? await this.#inline(inline, put)
          : scope && image.path
            ? await this.#file(image.path, scope, put)
            : undefined;

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
          const preview = await this.#inline(image, put).catch(() => undefined);

          if (preview) item.content.value.images.push(create(BlobRefSchema, preview.ref));
        }

        return item.content.value.images.length > 0 ? done() : init;
      }
    } catch {
      return init; // no preview: the item as the provider reported it
    }

    return init;
  }

  async #inline(
    image: InlineImage,
    put: PutPreview,
  ): Promise<{ ref: BlobRefInit; width?: number; height?: number; originalWidth?: number; originalHeight?: number }> {
    const data = Buffer.from(image.base64, "base64");

    if (INLINE_IMAGE_TYPES.has(image.mimeType) && image.mimeType !== "image/gif" && data.length <= MAX_INLINE_PREVIEW) {
      // Exactly what the model saw.
      const { width, height } = await sharp(data).metadata();

      return { ref: put(new Uint8Array(data), image.mimeType), ...(width && height && { width, height }) };
    }

    const preview = await forTranscript(new Uint8Array(data));

    return { ref: put(preview.data, preview.mimeType), width: preview.width, height: preview.height };
  }

  async #file(path: string, scope: ViewImageScope, put: PutPreview) {
    const preview = await forTranscript(readScopedImage(path, scope).data);

    return {
      ref: put(preview.data, preview.mimeType),
      width: preview.width,
      height: preview.height,
      originalWidth: preview.originalWidth,
      originalHeight: preview.originalHeight,
    };
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
 * - Codex MCP tools: `result.content: [{type: "image", data, mimeType}]`,
 * - Codex code mode: `call_id` with `output: [{type: "input_image", image_url: "data:...;base64,..."}]`,
 * - Grok ACP tool updates: wrapped `content` blocks or MCP `rawOutput`, scoped by `toolCallId`.
 */
export function inlineImages(rawJson: string, itemId: string): InlineImage[] {
  if (!rawJson || !rawJson.includes("image")) return [];
  let raw: JsonObject;

  try {
    raw = decodeJsonObject(JSON.parse(rawJson));
  } catch {
    return [];
  }

  const out: InlineImage[] = [];

  const append = (image: InlineImage) => {
    if (!out.some((previous) => previous.mimeType === image.mimeType && previous.base64 === image.base64))
      out.push(image);
  };

  const fromBlock = (block: JsonValue) => {
    const b = jsonObject(block);

    if (!b) return;
    const source = jsonObject(b["source"]);

    if (b["type"] === "image" && source?.["type"] === "base64" && isString(source["data"])) {
      append({ mimeType: String(source["media_type"] ?? "image/png"), base64: source["data"] });
    } else if (b["type"] === "image" && isString(b["data"])) {
      append({ mimeType: String(b["mimeType"] ?? "image/png"), base64: b["data"] });
    } else if (b["type"] === "inputImage" || b["type"] === "input_image") {
      const url = b["type"] === "inputImage" ? b["imageUrl"] : b["image_url"];
      const match = isString(url) ? /^data:([^;,]+);base64,(.*)$/s.exec(url) : undefined;

      if (match) append({ mimeType: match[1]!, base64: match[2]! });
    }
  };

  const r = raw;
  // Grok: the owned HTTP MCP handler records the result before returning it to the CLI.
  const direct = jsonObject(r["result"]);

  if (Array.isArray(direct?.["content"])) for (const block of direct["content"]) fromBlock(block);

  const toolId = r["toolCallId"];

  if (
    (r["sessionUpdate"] === "tool_call" || r["sessionUpdate"] === "tool_call_update") &&
    isString(toolId) &&
    toolId &&
    itemId.endsWith(`:${toolId}`)
  ) {
    if (Array.isArray(r["content"]))
      for (const content of r["content"]) {
        const block = jsonObject(content);

        if (block?.["type"] === "content") fromBlock(block["content"] ?? null);
      }

    const output = grokOutput(r["rawOutput"]);
    const result = jsonObject(output?.["result"]) ?? output;

    if (Array.isArray(result?.["content"])) for (const block of result["content"]) fromBlock(block);

    return out;
  }

  // Claude: a user message with tool results.
  const message = jsonObject(r["message"]);

  if (r["type"] === "user" && Array.isArray(message?.["content"])) {
    for (const value of message["content"]) {
      const block = jsonObject(value);

      if (!block) continue;

      if (block["type"] !== "tool_result" || block["tool_use_id"] !== itemId || !Array.isArray(block["content"]))
        continue;

      for (const inner of block["content"]) fromBlock(inner);
    }

    return out;
  }

  // Codex: app-server items and code-mode response items from the rollout.
  const item = jsonObject(jsonObject(r["params"])?.["item"]);
  const codexItemId = r["method"] === "rawResponseItem/completed" ? item?.["call_id"] : item?.["id"];

  if (item && codexItemId === itemId) {
    if (Array.isArray(item["contentItems"])) for (const c of item["contentItems"]) fromBlock(c);
    const result = jsonObject(item["result"]);

    if (Array.isArray(result?.["content"])) for (const c of result["content"]) fromBlock(c);

    if (Array.isArray(item["output"])) for (const c of item["output"]) fromBlock(c);
  }

  return out;
}

function grokOutput(output: JsonValue | undefined): JsonObject | undefined {
  if (!isString(output)) return jsonObject(output);

  try {
    return decodeJsonObject(JSON.parse(output));
  } catch {
    return undefined;
  }
}

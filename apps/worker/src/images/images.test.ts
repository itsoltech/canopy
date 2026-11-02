import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ItemStatus, ThreadEventSchema } from "@open-agents/contracts";
import { create } from "@bufbuild/protobuf";
import { tempDirs } from "@open-agents/testing";
import sharp from "sharp";
import { toolContent } from "../providers/claude/mapping.ts";
import { mapItem } from "../providers/codex/mapping.ts";
import { MAX_MODEL_BYTES } from "./normalize.ts";
import { inlineImages, PreviewStore } from "./previews.ts";
import { viewImage } from "./view-image.ts";

const tempDir = tempDirs();

let dir = "";
let cwd = "";
let attachments = "";
let outside = "";

const png = (width: number, height: number, alpha = false) =>
  sharp({ create: { width, height, channels: alpha ? 4 : 3, background: alpha ? "#ff000080" : "#336699" } }).png().toBuffer();

/** Random pixels: compresses badly, so the byte cap has to scale it down. */
async function noise(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
  return sharp(raw, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
}

beforeAll(async () => {
  dir = tempDir("oa-images-");
  cwd = join(dir, "repo");
  attachments = join(dir, "data", "attachments", "thread");
  outside = join(dir, "secret");
  for (const d of [cwd, attachments, outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(cwd, "wide.png"), await png(3000, 1000));
  writeFileSync(join(cwd, "logo.png"), await png(64, 64, true));
  writeFileSync(join(cwd, "notes.txt"), "not an image");
  writeFileSync(join(attachments, "shot.png"), await png(400, 300));
  writeFileSync(join(outside, "private.png"), await png(10, 10));
  symlinkSync(join(outside, "private.png"), join(cwd, "link.png"));
  writeFileSync(join(cwd, "noise.png"), await noise(2400, 2400));
});


describe("view_image", () => {
  const scope = () => ({ cwd, roots: [cwd, attachments] });

  test("scales to 2000 px on the long edge, JPEG without metadata for opaque images", async () => {
    const image = await viewImage("wide.png", scope());
    expect([image.width, image.height, image.originalWidth, image.originalHeight, image.mimeType]).toEqual([2000, 667, 3000, 1000, "image/jpeg"]);
    expect((await sharp(image.data).metadata()).exif).toBeUndefined();
  });

  test("keeps transparency as PNG and small images at their size", async () => {
    const image = await viewImage(join(cwd, "logo.png"), scope());
    expect([image.width, image.height, image.mimeType]).toEqual([64, 64, "image/png"]);
  });

  test("stays under the byte cap every provider takes", async () => {
    const image = await viewImage("noise.png", scope());
    expect(image.data.length).toBeLessThanOrEqual(MAX_MODEL_BYTES);
    expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(2000);
  });

  test("reads the thread's attachments", async () => {
    const image = await viewImage(join(attachments, "shot.png"), scope());
    expect([image.width, image.height]).toEqual([400, 300]);
  });

  test("nothing outside the working directory and attachments, not through .. or a symlink", async () => {
    const fails = (path: string) => viewImage(path, scope()).then(() => "", (e: Error) => e.message);
    expect(await fails(join(outside, "private.png"))).toContain("outside");
    expect(await fails("../secret/private.png")).toContain("outside");
    expect(await fails("link.png")).toContain("outside");
    expect(await fails("missing.png")).toContain("does not exist");
    expect(await fails("notes.txt")).toContain("not an image");
    expect(await fails(".")).toContain("not a file");
  });
});

describe("previews of what the agent looked at", () => {
  const store = () => new PreviewStore(join(dir, "data"));

  test("images inline in Claude tool results, Codex dynamic tool results and MCP results", async () => {
    const data = (await png(4, 4)).toString("base64");
    const claude = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu-1", content: [{ type: "text", text: "x" }, { type: "image", source: { type: "base64", media_type: "image/png", data } }] }] },
    });
    expect(inlineImages(claude, "tu-1")).toEqual([{ mimeType: "image/png", base64: data }]);
    expect(inlineImages(claude, "tu-2")).toEqual([]);
    const codex = JSON.stringify({ method: "item/completed", params: { item: { id: "c-1", contentItems: [{ type: "inputImage", imageUrl: `data:image/jpeg;base64,${data}` }] } } });
    expect(inlineImages(codex, "c-1")).toEqual([{ mimeType: "image/jpeg", base64: data }]);
    const mcp = JSON.stringify({ method: "item/completed", params: { item: { id: "m-1", result: { content: [{ type: "image", data, mimeType: "image/webp" }] } } } });
    expect(inlineImages(mcp, "m-1")).toEqual([{ mimeType: "image/webp", base64: data }]);
  });

  test("an image item gets a preview from the file at its path (Codex's own view_image)", async () => {
    const previews = store();
    const enriched = await previews.enrich({
      body: { case: "itemCompleted", value: { item: { itemId: "iv-1", status: ItemStatus.COMPLETED, content: { case: "image", value: { path: join(cwd, "wide.png"), source: "native" } } } } },
    });
    const image = enriched.body?.case === "itemCompleted" && enriched.body.value.item?.content?.case === "image" ? enriched.body.value.item.content.value : undefined;
    expect(image?.blob?.mimeType).toBe("image/webp");
    expect([image?.width, image?.height, image?.originalWidth, image?.originalHeight]).toEqual([2000, 667, 3000, 1000]);
  });

  test("a tool result with an image (Claude Read) shows that image as it was; sent once per link before the event", async () => {
    const previews = store();
    const data = (await png(8, 6)).toString("base64");
    const rawJson = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }] }] },
    });
    const enriched = await previews.enrich({
      rawJson,
      body: { case: "itemCompleted", value: { item: { itemId: "read-1", status: ItemStatus.COMPLETED, content: toolContent("Read", { file_path: "/x.png" }) } } },
    });
    const call = enriched.body?.case === "itemCompleted" && enriched.body.value.item?.content?.case === "toolCall" ? enriched.body.value.item.content.value : undefined;
    expect(call?.images?.length).toBe(1);
    const ref = call!.images![0]!;
    expect(ref.sizeBytes).toBe(BigInt(Buffer.from(data, "base64").length));

    const event = create(ThreadEventSchema, { threadId: "t", journalSeq: 1n, eventId: "e", body: enriched.body as never });
    const link = {};
    const chunks: { sha256: string; last: boolean }[] = [];
    previews.sendFor(link, event, (c) => chunks.push(c));
    previews.sendFor(link, event, (c) => chunks.push(c));
    expect(chunks).toEqual([expect.objectContaining({ sha256: ref.sha256, last: true })]);
    previews.sendFor({}, event, (c) => chunks.push(c)); // a new link gets it again
    expect(chunks.length).toBe(2);
  });

  test("no preview, no failure: the event stays as it came", async () => {
    const init = { body: { case: "itemCompleted" as const, value: { item: { itemId: "x", content: { case: "image" as const, value: { path: join(cwd, "notes.txt") } } } } } };
    expect(await store().enrich(init)).toBe(init);
  });
});

describe("view_image in the transcript", () => {
  test("Claude: the platform tool is an image item, a failure keeps its reason", async () => {
    const { withOutput } = await import("../providers/claude/mapping.ts");
    const content = toolContent("mcp__openagents__view_image", { path: "/a/b.png" });
    expect(content).toEqual({ case: "image", value: { path: "/a/b.png", source: "view_image" } });
    expect(withOutput(content, "view_image: /x is outside", true)).toEqual({ case: "image", value: { path: "/a/b.png", source: "view_image", detail: "view_image: /x is outside" } });
  });

  test("Codex: the namespaced dynamic tool is an image item, its built-in view_image a native one", () => {
    const viewed = mapItem({ type: "dynamicToolCall", id: "d-1", namespace: "openagents", tool: "view_image", arguments: { path: "/r/s.png" }, status: "completed", contentItems: [], success: true, durationMs: 3 } as never, true);
    expect(viewed.content).toEqual({ case: "image", value: { path: "/r/s.png", source: "view_image" } });
    const native = mapItem({ type: "imageView", id: "v-1", path: "/r/s.png" } as never, true);
    expect(native.content).toEqual({ case: "image", value: { path: "/r/s.png", source: "native" } });
  });
});

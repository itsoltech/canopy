import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import sharp from "sharp";
import { z } from "zod";
import { MAX_BYTES } from "../agent-tools-mcp/protocol.ts";
import type { AutomationCall } from "../agent-tools-mcp/session-policy.ts";
import {
  observeDesktopWindows,
  resolveDesktopTarget,
  sameDesktopWindow,
  verifiedDesktopWindow,
  type DesktopNativeCall,
  type DesktopWindow,
  type DesktopTarget,
} from "./desktop-window.ts";
import { serializeAgentTool } from "./queue.ts";

export interface DesktopObservation {
  readonly data: Uint8Array;
  readonly mimeType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly target?: DesktopTarget;
  readonly windowAligned: boolean;
}

const argsSchema = z.strictObject({
  app: z.string().nullish(),
  window_id: z.string().nullish(),
  screen: z.number().int().nonnegative().nullish(),
  output_path: z.string().nullish(),
});

const nativeScreenshot = z.strictObject({
  format: z.enum(["png", "jpeg", "jpg"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  scale_factor: z.number().positive().max(16),
});

export function desktopScreenshotScope(args: AutomationCall["arguments"]) {
  return argsSchema.safeParse(args).data;
}

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const pngEnd = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

function staticPng(data: Buffer) {
  if (!data.subarray(0, 8).equals(png) || !data.subarray(-12).equals(pngEnd)) return false;

  // libvips can decode the first PNG image without reporting additional APNG frames.
  for (let offset = 8; offset + 12 <= data.length;) {
    if (data.toString("ascii", offset + 4, offset + 8) === "acTL") return false;
    offset += data.readUInt32BE(offset) + 12;
  }

  return true;
}

type InlineImage = Pick<DesktopObservation, "data" | "mimeType" | "width" | "height"> & {
  orientation: number;
  single: boolean;
};

/** Decode just the bytes in model-visible MCP content. Paths and embedded text never supply images. */
async function readImage(result: CallToolResult, signal: AbortSignal): Promise<InlineImage | undefined> {
  const blocks = result.content.filter((item) => item.type === "image");

  const block = blocks.findLast(
    (item) => !item.annotations?.audience || item.annotations.audience.includes("assistant"),
  );

  if (
    !block ||
    (block.mimeType !== "image/png" && block.mimeType !== "image/jpeg") ||
    !block.data.length ||
    block.data.length > MAX_BYTES ||
    block.data.length % 4 !== 0
  )
    return undefined;
  const mimeType = block.mimeType;

  try {
    // The bridge also bounds the whole JSON-RPC reply. Reserve its wrapper and worst-case escaped request id.
    if (
      signal.aborted ||
      result.content.some((item) => item.type === "text" && item.text.length > MAX_BYTES - 2048) ||
      Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES - 2048
    )
      return undefined;

    return await serializeAgentTool<InlineImage | undefined>(
      "desktop-observation",
      async () => {
        if (signal.aborted) return undefined;
        const data = Buffer.from(block.data, "base64");

        if (data.byteLength < 12 || data.toString("base64") !== block.data) return undefined;

        if (
          mimeType === "image/png"
            ? !staticPng(data)
            : data.readUInt16BE(0) !== 0xffd8 || data.readUInt16BE(data.length - 2) !== 0xffd9
        )
          return undefined;

        const image = sharp(data, { limitInputPixels: 32_000_000, failOn: "warning", animated: false });
        const { width, height, autoOrient, format, pages, orientation } = await image.metadata();

        if (
          !width ||
          !height ||
          width > 8192 ||
          height > 8192 ||
          width * height > 32_000_000 ||
          (pages ?? 1) !== 1 ||
          format !== (mimeType === "image/png" ? "png" : "jpeg") ||
          signal.aborted
        )
          return undefined;
        // Header-only parsing accepts truncated image data. Validate the bounded image without storing a decoded raster.
        await image.resize(1, 1, { fit: "fill" }).raw().toBuffer();

        return signal.aborted
          ? undefined
          : {
              data,
              width: autoOrient.width,
              height: autoOrient.height,
              mimeType,
              orientation: orientation ?? 1,
              single: blocks.length === 1,
            };
      },
      1_000,
    );
  } catch {
    return undefined;
  }
}

interface Capture {
  command: string;
  args: AutomationCall["arguments"];
  result: CallToolResult;
  target: DesktopTarget | undefined;
  before: DesktopWindow[] | undefined;
}

/** Only an ordinary, unmodified native window screenshot can be attached to a live window. */
export async function desktopObservation(
  capture: Capture,
  native: DesktopNativeCall,
  signal: AbortSignal,
): Promise<DesktopObservation | undefined> {
  const { result, command, target, before } = capture;

  if (result.isError || !result.content.some((block) => block.type === "image")) return undefined;
  const args = command === "screenshot" ? desktopScreenshotScope(capture.args) : undefined;
  const shape = nativeScreenshot.safeParse(result.structuredContent?.["data"]).data;

  const initial =
    target && before && args && shape && !args.output_path && args.screen == null
      ? verifiedDesktopWindow(before, target)
      : undefined;

  const after = initial && (await observeDesktopWindows(native, signal, args?.app ?? undefined));

  // Repeat the actual native selector. Another process with the same app name (or another
  // candidate for an unqualified window ID) would make the screenshot's ownership ambiguous.
  const selected =
    after && args && resolveDesktopTarget(after, { app: args.app ?? undefined, id: args.window_id ?? undefined });

  const live =
    after &&
    target &&
    selected?.app === target.app &&
    sameDesktopWindow(target.identity, selected.identity) &&
    verifiedDesktopWindow(after, target);

  const image = await readImage(result, signal);

  if (!image || signal.aborted) return undefined;
  const { data, width, height, mimeType } = image;

  const full =
    image.single &&
    shape?.width === width &&
    shape.height === height &&
    (shape.format === "png") === (mimeType === "image/png");

  if (full && live && initial && target) {
    const rect = initial.bounds;

    const windowAligned = Boolean(
      rect &&
      live.bounds?.width === rect.width &&
      live.bounds.height === rect.height &&
      image.orientation === 1 &&
      Math.round(rect.width * shape.scale_factor) === width &&
      Math.round(rect.height * shape.scale_factor) === height,
    );

    const title = initial.title && initial.title === live.title ? `${target.app} — ${initial.title}` : target.app;

    return {
      data,
      width,
      height,
      mimeType,
      title: title.replaceAll(/\p{Cc}/gu, " ").slice(0, 1024),
      target,
      windowAligned,
    };
  }

  const display = full && args && !args.app && !args.window_id && !args.output_path;

  const title = display
    ? args.screen == null
      ? "Desktop screenshot"
      : `Display ${args.screen + 1} screenshot`
    : command === "screenshot"
      ? "Agent screenshot"
      : "Agent observation";

  return { data, width, height, mimeType, title, windowAligned: false };
}

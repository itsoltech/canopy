import { Result, Schema } from "effect";
import type { ToolJsonSpec } from "../agent-bus/tools.ts";

/**
 * view_image: a platform tool the worker runs itself (docs/agent-bus.md, "view_image"). It reads an image from the
 * thread's workspace or attachments, scales it to a size every model takes and returns it as image content, so any
 * model can look at an image regardless of its own limits. Not an agent bus call: it never reaches the gateway,
 * the transcript shows it as an image item with a preview of what the model saw.
 */

export const VIEW_IMAGE_TOOL = "view_image";

export const ViewImage = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)).annotate({
    description:
      "Absolute path of the image (or relative to the thread's working directory), e.g. an attachment path from the user's message.",
  }),
});

export type ViewImageArgs = Schema.Schema.Type<typeof ViewImage>;

export const VIEW_IMAGE_DESCRIPTION =
  "Look at an image file: PNG, JPEG, GIF, WebP, HEIC, AVIF or TIFF in the working directory or attached by the user. " +
  "The image is scaled to at most 2000 px on its long edge and returned to you as an image. Use it for screenshots, photos and diagrams; " +
  "read text files with your normal tools.";

export function viewImageSpec(): ToolJsonSpec {
  const document = Schema.toJsonSchemaDocument(ViewImage, { onExcessProperty: "error" });

  return {
    name: VIEW_IMAGE_TOOL,
    description: VIEW_IMAGE_DESCRIPTION,
    inputSchema: document.schema as Record<string, unknown>,
  };
}

export function decodeViewImage(argumentsJson: string | unknown): Result.Result<ViewImageArgs, string> {
  let raw: unknown = argumentsJson;

  if (typeof argumentsJson === "string") {
    try {
      raw = argumentsJson.trim() === "" ? {} : JSON.parse(argumentsJson);
    } catch {
      return Result.fail(`${VIEW_IMAGE_TOOL}: arguments are not valid JSON`);
    }
  }

  const decoded = Schema.decodeUnknownResult(ViewImage)(raw, { onExcessProperty: "error" });

  return Result.isSuccess(decoded)
    ? Result.succeed(decoded.success)
    : Result.fail(`${VIEW_IMAGE_TOOL}: ${decoded.failure.message}`);
}

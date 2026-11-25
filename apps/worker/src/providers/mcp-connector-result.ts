import { Option, Schema } from "effect";
import type { McpAttachmentContent } from "./mcp-bus.ts";

const envelope = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ content: Schema.Array(Schema.Json) })),
);

const imageBlock = Schema.is(
  Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: Schema.String }),
);

export function connectorImages(resultJson: string, redact: (text: string) => string) {
  const result = envelope(resultJson);

  if (Option.isNone(result)) return [];

  return result.value.content
    .filter(imageBlock)
    .map<McpAttachmentContent>(({ type, data, mimeType }) =>
      mimeType.startsWith("image/") &&
      data.length > 0 &&
      !/[^A-Za-z0-9+/=]/.test(data) &&
      redact(data) === data &&
      redact(mimeType) === mimeType
        ? { type, data, mimeType }
        : { type: "text", text: "Canopy omitted an invalid or redacted MCP image." },
    );
}

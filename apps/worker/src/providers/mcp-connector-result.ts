import { Option, Schema } from "effect";
import type { McpAttachmentContent } from "./mcp-bus.ts";

const envelope = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      content: Schema.Array(Schema.Json),
      structuredContent: Schema.optionalKey(Schema.JsonObject),
    }),
  ),
);

const imageBlock = Schema.is(
  Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: Schema.String }),
);

export function connectorNativeResult(resultJson: string, redact: (text: string) => string) {
  const result = envelope(resultJson);

  if (Option.isNone(result)) return;
  const images = result.value.content.filter(imageBlock);

  if (!images.length) return;

  const content = images.map<McpAttachmentContent>(({ type, data, mimeType }) =>
    mimeType.startsWith("image/") &&
    data.length > 0 &&
    !/[^A-Za-z0-9+/=]/.test(data) &&
    redact(data) === data &&
    redact(mimeType) === mimeType
      ? { type, data, mimeType }
      : { type: "text", text: "Canopy omitted an invalid or redacted MCP image." },
  );

  const { structuredContent } = result.value;

  if (!structuredContent) return { content };
  const metadata = JSON.stringify(structuredContent);

  return { content, ...(redact(metadata) === metadata && { structuredContent }) };
}

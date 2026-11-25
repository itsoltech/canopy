import type { JsonObject, JsonValue as MutableJsonValue } from "@bufbuild/protobuf";
import type { JsonValue } from "@canopy/domain";
import { isJsonArray, isJsonObject } from "./json.ts";

const TEXT_BYTES = 100_000;
const RESULT_BYTES = 10_000_000;
const RESPONSE_BYTES = 20_000_000;

const jsonBytes = (value: JsonValue) => Buffer.byteLength(JSON.stringify(value));

export const mcpResultTooLarge = {
  content: [{ type: "text", text: "MCP result too large; narrow the query" }],
  isError: true,
};

const isMcpImage = (value: JsonValue) => isJsonObject(value) && value["type"] === "image";

/** Keep binary blocks out of the text used by older workers and the tool transcript. */
export function connectorResultFields(result: JsonValue) {
  const resultJson = JSON.stringify(result);
  const blocks = isJsonObject(result) ? result["content"] : undefined;

  if (!isJsonObject(result) || !isJsonArray(blocks) || !blocks.some(isMcpImage))
    return { content: resultJson, resultJson };

  return { content: JSON.stringify({ ...result, content: blocks.filter((block) => !isMcpImage(block)) }), resultJson };
}

function omission(images: number, other: number) {
  return {
    type: "text",
    text: `Canopy omitted ${images} image ${images === 1 ? "block" : "blocks"} and ${other} other MCP result ${other === 1 ? "part" : "parts"}. Narrow the query to retrieve them.`,
  };
}

/** Budget the serialized envelope in UTF-8, including separators and the omission notice. */
export function limitMcpResult(result: JsonObject): JsonObject {
  const { content, isError, structuredContent, ...fields } = result;

  if (!isJsonArray(content)) return jsonBytes(result) <= TEXT_BYTES ? result : mcpResultTooLarge;
  const parts = content.map((value) => ({ value, bytes: 1 + jsonBytes(value), image: isMcpImage(value), keep: false }));
  const imageCount = parts.filter((part) => part.image).length;
  const textCount = parts.length - imageCount;
  const baseBytes = jsonBytes({ ...result, content: [] });
  const textBytes = parts.reduce((bytes, part) => bytes + (part.image ? 0 : part.bytes), baseBytes);
  const imageBytes = parts.reduce((bytes, part) => bytes + (part.image ? part.bytes : 0), 0);

  if (
    textBytes - Number(textCount > 0) <= TEXT_BYTES &&
    textBytes + imageBytes - Number(parts.length > 0) <= RESULT_BYTES
  )
    return result;

  const kept = new Map<string, MutableJsonValue>();
  const metadata = Object.entries(fields);
  const base = { content: [], isError: isError ?? false };

  if (structuredContent !== undefined) metadata.unshift(["structuredContent", structuredContent]);

  let textRemaining = TEXT_BYTES - jsonBytes(base) - jsonBytes(omission(imageCount, textCount + metadata.length)) - 1;

  let omittedImages = 0;
  let omittedOther = 0;

  for (const [key, value] of metadata) {
    const bytes = jsonBytes({ [key]: value }) - 1;

    if (bytes > textRemaining) omittedOther++;
    else {
      kept.set(key, value);
      textRemaining -= bytes;
    }
  }

  for (const part of parts) {
    if (part.image) continue;

    if (part.bytes > textRemaining) omittedOther++;
    else {
      part.keep = true;
      textRemaining -= part.bytes;
    }
  }

  let imageRemaining = RESULT_BYTES - TEXT_BYTES + textRemaining;

  for (const part of parts) {
    if (!part.image) continue;

    if (part.bytes > imageRemaining) omittedImages++;
    else {
      part.keep = true;
      imageRemaining -= part.bytes;
    }
  }

  const keptContent = parts.filter((part) => part.keep).map((part) => part.value);

  if (!keptContent.length && !kept.has("structuredContent")) base.isError = true;
  keptContent.push(omission(omittedImages, omittedOther));

  return { ...base, ...Object.fromEntries(kept), content: keptContent };
}

/** Bound the bytes read before the SDK parses a response, including streamed responses. */
export function limitMcpResponse(response: Response, onLimit: () => void): Response {
  if (!response.body) return response;

  let bytes = 0;

  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;

        if (bytes <= RESPONSE_BYTES) controller.enqueue(chunk);
        else {
          onLimit();
          controller.error(new Error("MCP response exceeded its byte limit"));
        }
      },
    }),
  );

  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

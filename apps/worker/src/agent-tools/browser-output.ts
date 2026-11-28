import type { JsonValue } from "@canopy/domain";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { redactToolOutput } from "../providers/secret-tool-output.ts";
import { redactSecretText, secretPatterns } from "../runtime/project-secret-guard.ts";
import type { BlockedRequest } from "./browser-leak-guard.ts";

const json = z.json();

/** Mask values entered from project logins in a browser result: a snapshot or eval can read them back. */
export function maskBrowserResult(
  result: CallToolResult | undefined,
  values: readonly string[],
  blocked: readonly BlockedRequest[],
): CallToolResult | undefined {
  if (!result || (!values.length && !blocked.length)) return result;
  const patterns = secretPatterns(values);
  const redact = (text: string) => redactSecretText(text, patterns);

  const content = result.content.map((block) =>
    block.type === "text" ? { ...block, text: redact(block.text) } : block,
  );

  const structured = json.safeParse(result.structuredContent);

  // A request can carry the value in its host name, so the notice is masked too.
  const notices = blocked.map(({ login, origin }) => ({
    type: "text" as const,
    text: redact(
      `Canopy blocked a request to ${origin} that carried login ${login}. A login's values may only be sent to its websites.`,
    ),
  }));

  return {
    ...result,
    content: [...content, ...notices],
    ...(structured.success &&
      result.structuredContent && { structuredContent: maskStructured(redactToolOutput(structured.data, redact)) }),
  };
}

const record = z.record(z.string(), z.json());

function maskStructured(value: JsonValue): Record<string, JsonValue> {
  const parsed = record.safeParse(value);

  return parsed.success ? parsed.data : {};
}

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ISSUE_MENTION_LIMITS } from "@canopy/domain";
import { parseJson, type JsonValue } from "@canopy/domain/json";
import { Option, Schema } from "effect";

export interface ProviderIssue {
  key: string;
  title: string;
  url: string;
  description: string;
  status?: string;
  pullRequest?: boolean;
}

export interface IssueProviderOptions {
  repository?: string;
  limit?: number;
  includePullRequests?: boolean;
  onPartialFailure?: (kind: "issues" | "pull requests") => void;
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

type Arguments = NonNullable<Parameters<Client["callTool"]>[0]["arguments"]>;

export type IssueToolCall = (tool: string, args: Arguments) => Promise<ToolResult>;

export const projectKey = /^[a-z][a-z\d_]*-[1-9]\d*$/i;
export const maybeText = Schema.optional(Schema.NullOr(Schema.String));

const envelope = Schema.decodeUnknownOption(
  Schema.Struct({
    isError: Schema.optional(Schema.Boolean),
    structuredContent: Schema.optional(Schema.JsonObject),
    content: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.String, text: maybeText }))),
  }),
);

export function payload(result: ToolResult): JsonValue {
  const parsed = Option.getOrUndefined(envelope(result));

  if (!parsed || parsed.isError) throw new Error("Issue provider read failed");

  if (parsed.structuredContent != null) return parsed.structuredContent;
  const text = parsed.content?.find((item) => item.type === "text")?.text;
  const value = text && text.length <= 2_000_000 ? parseJson(text) : undefined;

  if (value == null) throw new Error("Invalid issue provider response");

  return value;
}

function line(text: string, limit: number) {
  return text
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim()
    .slice(0, limit)
    .trimEnd()
    .toWellFormed();
}

export function issue(
  key: string,
  title: string,
  url: URL,
  description?: string | null,
  status?: string | null,
): ProviderIssue | undefined {
  const normalizedTitle = line(title, ISSUE_MENTION_LIMITS.title);

  if (!normalizedTitle || key.length > ISSUE_MENTION_LIMITS.key || url.href.length > ISSUE_MENTION_LIMITS.url) return;
  const state = line(status ?? "", ISSUE_MENTION_LIMITS.status);
  const body = (description ?? "").replaceAll("\r\n", "\n").replaceAll("\u0000", "\uFFFD").trim();

  return {
    key,
    title: normalizedTitle,
    url: url.href,
    description: body.slice(0, ISSUE_MENTION_LIMITS.description).toWellFormed(),
    ...(state && { status: state }),
  };
}

/** The callback already decoded MCP JSON. Inspect only rows from its bounded first page. */
export function matches(
  rows: readonly JsonValue[],
  limit: number,
  parse: (row: JsonValue) => ProviderIssue | undefined,
): ProviderIssue[] {
  const issues = new Map<string, ProviderIssue>();

  for (const row of rows.slice(0, 100)) {
    const match = parse(row);

    if (match) issues.set(match.url, match);

    if (issues.size === limit) break;
  }

  return Array.from(issues.values());
}

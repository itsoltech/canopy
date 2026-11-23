import { parseIssueUrl, type JsonValue } from "@canopy/domain";
import { isJsonArray, objectOf } from "@canopy/domain/json";
import { Option, Schema } from "effect";
import {
  issue,
  matches,
  maybeText,
  payload,
  projectKey,
  type IssueProviderOptions,
  type IssueToolCall,
  type ProviderIssue,
} from "./issue-providers/common.ts";
import { githubIssues } from "./issue-providers/github.ts";
import { jiraIssues } from "./issue-providers/jira.ts";

export type { IssueToolCall, ProviderIssue } from "./issue-providers/common.ts";

const linearRow = Schema.decodeUnknownOption(
  Schema.Struct({
    id: maybeText,
    identifier: maybeText,
    title: Schema.String,
    url: Schema.String,
    description: maybeText,
    status: maybeText,
    state: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Struct({ name: Schema.String })]))),
  }),
);

const linearPath = /^(\/[^/]+\/issue\/)([^/]+)(?:\/|$)/i;

function linearMatch(value: JsonValue) {
  const row = Option.getOrUndefined(linearRow(value));
  const key = row?.identifier ?? row?.id;
  const url = row && parseIssueUrl(row.url);

  if (!row || !key || !projectKey.test(key) || !url) return;
  const state = Schema.is(Schema.String)(row.state) ? row.state : row.state?.name;

  return issue(key, row.title, url, row.description, row.status ?? state);
}

async function linearIssues(query: string, url: URL | undefined, limit: number, call: IssueToolCall) {
  const link = url && linearPath.exec(url.pathname);
  const key = url ? link?.[2] : query;

  if (url && (!key || !projectKey.test(key))) return [];

  if (key && projectKey.test(key)) {
    const data = payload(await call("get_issue", { id: key.toUpperCase() }));
    const match = linearMatch(objectOf(data)["issue"] ?? data);

    if (!match || match.key.toUpperCase() !== key.toUpperCase()) return [];

    if (url) {
      const target = new URL(match.url);
      const path = linearPath.exec(target.pathname);

      if (target.origin !== url.origin || path?.[1] !== link?.[1] || path?.[2]?.toUpperCase() !== key.toUpperCase())
        return [];
    }

    return [match];
  }

  const data = payload(await call("list_issues", { ...(query && { query }), limit }));
  const rows = objectOf(data)["issues"];

  if (!isJsonArray(rows)) throw new Error("Invalid Linear issue list");

  return matches(rows, limit, linearMatch);
}

/** Only fixed provider reads are dispatched. The gateway supplies an authorized MCP client for this account. */
export async function searchProviderIssues(
  typeId: string,
  query: string,
  call: IssueToolCall,
  options: IssueProviderOptions = {},
): Promise<ProviderIssue[]> {
  const term = query.trim();
  const url = parseIssueUrl(term);

  if (term.length > 256 && !url) throw new Error("Issue search is too long");

  if (/^https?:\/\//i.test(term) && !url) return [];
  const limit = Math.min(50, Math.max(1, Math.trunc(options.limit || 10)));

  switch (typeId) {
    case "linear":
      return linearIssues(term, url, limit, call);
    case "atlassian":
      return jiraIssues(term, url, limit, call);
    case "github":
      return githubIssues(term, url, limit, call, options);
    default:
      throw new Error("Unsupported issue provider");
  }
}

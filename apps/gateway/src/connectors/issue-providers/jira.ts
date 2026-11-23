import { ISSUE_MENTION_LIMITS, parseIssueUrl, type JsonValue } from "@canopy/domain";
import { isJsonArray, listOf, objectOf, str } from "@canopy/domain/json";
import { Option, Predicate, Schema } from "effect";
import { issue, matches, maybeText, payload, projectKey, type IssueToolCall } from "./common.ts";

const cloudId = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

const site = Schema.decodeUnknownOption(
  Schema.Struct({
    id: maybeText,
    cloudId: maybeText,
    url: Schema.String,
    products: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
    scopes: Schema.optional(Schema.Array(Schema.String)),
  }),
);

const row = Schema.decodeUnknownOption(
  Schema.Struct({
    key: Schema.String,
    fields: Schema.Struct({
      summary: Schema.String,
      status: Schema.optional(Schema.NullOr(Schema.Struct({ name: Schema.String }))),
      description: Schema.optional(Schema.Json),
    }),
  }),
);

function unwrapped(value: JsonValue) {
  return objectOf(value)["data"] ?? value;
}

/** Jira v3 descriptions may be Atlassian Document Format. Read visible text and preserve paragraph breaks. */
function body(value: JsonValue | undefined) {
  if (Predicate.isString(value)) return value;
  let text = "";
  let budget = 1000;

  function visit(node: JsonValue | undefined, depth: number) {
    budget--;

    if (depth > 24) return;
    const data = objectOf(node);
    const type = data["type"];

    if (type === "text") text += str(data["text"]).slice(0, ISSUE_MENTION_LIMITS.description - text.length);

    if (type === "hardBreak") text += "\n";

    for (const child of listOf(data["content"])) {
      if (budget <= 0 || text.length >= ISSUE_MENTION_LIMITS.description) break;
      visit(child, depth + 1);
    }

    if (["paragraph", "heading", "codeBlock"].includes(str(type))) text += "\n";
  }

  if (objectOf(value)["type"] === "doc") visit(value, 0);

  return text;
}

function sitesOf(value: JsonValue, selectedOrigin: string | undefined) {
  const decoded = unwrapped(value);
  const rows = objectOf(decoded)["resources"] ?? decoded;

  if (!isJsonArray(rows)) throw new Error("Invalid Jira site list");
  const sites = new Map<string, URL>();

  for (const item of rows.slice(0, 256)) {
    const resource = Option.getOrUndefined(site(item));
    const id = resource?.cloudId ?? resource?.id;
    const url = resource && parseIssueUrl(resource.url);

    if (!resource || !id || !cloudId.test(id) || !url || url.pathname !== "/") continue;

    if (resource.products && !resource.products.some((p) => p.id === "jira")) continue;

    if (resource.scopes?.length && !resource.scopes.some((scope) => scope.includes("jira"))) continue;

    if (selectedOrigin && url.origin !== selectedOrigin) continue;
    sites.set(id, url);

    if (sites.size === 4) break;
  }

  return sites;
}

function jqlQuery(query: string) {
  if (!query) return "updated >= -30d ORDER BY updated DESC";

  if (projectKey.test(query)) return `key = "${query.toUpperCase()}"`;

  if (/^[1-9]\d{0,15}$/.test(query)) return `id = ${query}`;
  // Lucene phrase quoting happens inside a JQL string literal. Escape both layers.
  const phrase = query.replace(/["\\]/g, "\\$&");
  const literal = JSON.stringify(`"${phrase}"`);

  return `text ~ ${literal} ORDER BY updated DESC`;
}

async function searchSite(id: string, url: URL, term: string, limit: number, call: IssueToolCall) {
  const result = await call("searchJiraIssuesUsingJql", {
    cloudId: id,
    jql: jqlQuery(term),
    fields: ["summary", "description", "status"],
    maxResults: limit,
  });

  const issues = objectOf(unwrapped(payload(result)))["issues"];
  const items = objectOf(issues)["nodes"] ?? issues;

  if (!isJsonArray(items)) throw new Error("Invalid Jira issue list");

  return matches(items, limit, (item) => {
    const match = Option.getOrUndefined(row(item));

    if (!match || !projectKey.test(match.key)) return;

    if (projectKey.test(term) && match.key.toUpperCase() !== term.toUpperCase()) return;

    return issue(
      match.key,
      match.fields.summary,
      new URL(`/browse/${match.key}`, url),
      body(match.fields.description),
      match.fields.status?.name,
    );
  });
}

export async function jiraIssues(query: string, url: URL | undefined, limit: number, call: IssueToolCall) {
  const term = url ? /^\/browse\/([^/]+)\/?$/i.exec(url.pathname)?.[1] : query;

  if (term === undefined || (url && !projectKey.test(term))) return [];
  const sites = sitesOf(payload(await call("getAccessibleAtlassianResources", {})), url?.origin);

  // Each cloud has its own grants. Keep hits from accessible clouds if another denies the search.
  const settled = await Promise.allSettled(
    Array.from(sites, ([id, origin]) => searchSite(id, origin, term, limit, call)),
  );

  const pages = settled.flatMap((page) => (page.status === "fulfilled" ? [page.value] : []));

  if (settled.length && !pages.length) throw new Error("Jira search failed");
  const results = [];

  for (let index = 0; index < limit; index++) {
    for (const page of pages) {
      const match = page[index];

      if (match) results.push(match);

      if (results.length === limit) return results;
    }
  }

  return results;
}

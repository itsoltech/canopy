import { create } from "@bufbuild/protobuf";
import { IssueMentionSchema, MentionKind, type Mention, type ui } from "@canopy/contracts";

/** Maximum UTF-16 lengths for a selected issue's snapshot in a draft or message. */
export const ISSUE_MENTION_LIMITS = { key: 256, title: 512, status: 100, description: 4000, url: 2048 } as const;

const trackerNames = new Map([
  ["linear", "Linear"],
  ["atlassian", "Jira"],
  ["github", "GitHub"],
]);

export const issueTrackerName = (provider: string) => trackerNames.get(provider) ?? provider;

/** A bare number in a hash query is GitHub's issue / pull request number. */
export function exactTrackerMatch(match: ui.IssueSearchMatch, query: string) {
  const term = query.trim();

  if (term === match.url || term.toLowerCase() === match.key.toLowerCase()) return true;
  const number = /^#?([1-9]\d*)$/.exec(term)?.[1];

  return Boolean(number && match.provider === "github" && match.key.endsWith(`#${number}`));
}

/** Keep each group together and put its exact match first, preserving provider rank within each tier. */
export function orderedTrackerMatches(matches: readonly ui.IssueSearchMatch[], query: string): ui.IssueSearchMatch[] {
  const exact = new Set(matches.filter((match) => exactTrackerMatch(match, query)));
  const firstKind = matches.find((match) => exact.has(match))?.pullRequest ?? false;

  const rank = (match: ui.IssueSearchMatch) => Number(match.pullRequest !== firstKind) * 2 + Number(!exact.has(match));

  return [...matches].sort((a, b) => rank(a) - rank(b));
}

export function issueMention({
  accountId,
  key,
  title,
  url,
  provider,
  status,
  description,
  pullRequest,
}: ui.IssueSearchMatch) {
  return {
    kind: MentionKind.ISSUE,
    name: key,
    label: key,
    path: url,
    source: accountId,
    isDir: false,
    issue: create(IssueMentionSchema, { provider, title, status, description, pullRequest }),
  };
}

export function parseIssueUrl(value: string): URL | undefined {
  if (value.length > ISSUE_MENTION_LIMITS.url || /[\s\\?#\p{Cc}]/u.test(value)) return;
  const url = URL.parse(value);

  if (url?.protocol === "https:" && !url.username && !url.password && url.href.length <= ISSUE_MENTION_LIMITS.url)
    return url;

  return undefined;
}

/** The numbered issue or pull request identified by a canonical GitHub or GitHub Enterprise URL. */
export function githubMentionTarget(url: URL) {
  const match = /^\/([a-z\d][\w.-]*\/[\w.-]+)\/(issues|pull)\/([1-9]\d*)\/?$/i.exec(url.pathname);

  if (!match) return undefined;
  const number = Number(match[3]);

  if (!Number.isSafeInteger(number)) return undefined;

  return { repository: match[1]!, number, pullRequest: match[2]!.toLowerCase() === "pull" };
}

function validTarget(m: Mention) {
  const url = parseIssueUrl(m.path);

  if (!url || !m.issue) return false;

  if (m.issue.provider !== "github") return !m.issue.pullRequest;
  const target = githubMentionTarget(url);

  return Boolean(
    target &&
    target.pullRequest === m.issue.pullRequest &&
    `${target.repository}#${target.number}`.toLowerCase() === m.name.toLowerCase(),
  );
}

export function validIssueSnapshot(m: Mention): boolean {
  const issue = m.issue;

  return Boolean(
    issue &&
    trackerNames.has(issue.provider) &&
    m.name.length <= ISSUE_MENTION_LIMITS.key &&
    !/[\s\p{Cc}]/u.test(m.name) &&
    (!m.label || m.label === m.name) &&
    validTarget(m) &&
    issue.title.trim() &&
    !/[\p{Cc}\u2028\u2029]/u.test(issue.title) &&
    issue.title.length <= ISSUE_MENTION_LIMITS.title &&
    issue.status.length <= ISSUE_MENTION_LIMITS.status &&
    !/[\p{Cc}\u2028\u2029]/u.test(issue.status) &&
    !issue.description.includes("\0") &&
    issue.description.length <= ISSUE_MENTION_LIMITS.description,
  );
}

/** Quote external content as data. One line per issue keeps the platform note separate from the user's message. */
export function issueNotes(mentions: readonly Mention[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const m of mentions) {
    if (m.kind !== MentionKind.ISSUE || !m.issue) continue;
    const identity = JSON.stringify([m.source, m.path]);

    if (seen.has(identity)) continue;
    seen.add(identity);
    const { pullRequest, provider, title, status, description } = m.issue;
    const kind = pullRequest ? "pull_request" : "issue";
    lines.push(JSON.stringify({ kind, provider, key: m.name, title, url: m.path, status, description }));
  }

  return lines.length ? ["[canopy] Tracker references selected by the user:", ...lines] : [];
}

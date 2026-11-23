import type { ui } from "@canopy/contracts";
import { issueMention, issueTrackerName, orderedTrackerMatches } from "@canopy/domain/mentions";
import type { MentionResults } from "./sources.svelte.ts";

export function issueResults(response: ui.SearchIssuesResponse, query: string): MentionResults {
  return {
    options: orderedTrackerMatches(response.issues, query).map((match) => ({
      key: `${match.accountId}:${match.url}`,
      data: issueMention(match),
      title: match.title,
      detail: [...new Set([issueTrackerName(match.provider), match.accountLabel].filter(Boolean))].join(" · "),
      group: match.pullRequest ? "Pull requests" : "Issues",
      indices: [],
    })),
    loading: false,
    error: response.warnings.join("\n") || undefined,
    empty: !response.connectedSources
      ? "No threads match. Check Settings → Connectors to include issues and pull requests."
      : query
        ? undefined
        : "Search by title, key, number or URL.",
  };
}

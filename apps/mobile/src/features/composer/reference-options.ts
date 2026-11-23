import { MentionKind, type ui } from "@canopy/contracts";
import { issueMention, issueTrackerName, orderedTrackerMatches } from "@canopy/domain/mentions";
import type { MentionOption } from "./useMentionSuggestions";

export function issueOptions({ issues }: ui.SearchIssuesResponse, query: string): MentionOption[] {
  return orderedTrackerMatches(issues, query).map((match): MentionOption => {
    const source = issueTrackerName(match.provider);

    return {
      key: JSON.stringify([match.accountId, match.url]),
      mention: issueMention(match),
      title: match.title,
      detail: [match.key, source, match.accountLabel !== source && match.accountLabel, match.status]
        .filter(Boolean)
        .join(" · "),
      group: match.pullRequest ? "Pull requests" : "Issues",
    };
  });
}

export function threadOptions({ threads }: ui.SearchThreadsResponse): MentionOption[] {
  return threads.map((thread) => {
    const title = thread.title || "Untitled";

    return {
      key: `thread:${thread.id}`,
      mention: { kind: MentionKind.THREAD, name: thread.id, label: title, path: "", source: "", isDir: false },
      title,
      detail: thread.status,
      group: "Threads",
    };
  });
}

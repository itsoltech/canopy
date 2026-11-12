import type { github } from "@canopy/contracts";

export interface PullRequestPickerItem {
  key: string;
  label: string;
  url: string;
  linked: boolean;
  pr?: github.RepositoryPullRequest;
}

/** Direct links share the list's pointer and keyboard selection, including other repositories. */
export function pullRequestPickerItems(
  query: string,
  data: github.RepositoryPullRequestsResponse | undefined,
): PullRequestPickerItem[] {
  const items = (data?.items ?? []).map((pr) => ({
    key: String(pr.number),
    label: `#${pr.number} ${pr.title}`,
    url: `https://github.com/${data?.repositoryName}/pull/${pr.number}`,
    linked: pr.linked,
    pr,
  }));

  const input = query.trim();
  const numeric = /^#?[1-9][0-9]*$/.test(input);

  const url = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(input)
    ? input
    : numeric && data?.repositoryName
      ? `https://github.com/${data.repositoryName}/pull/${input.replace(/^#/, "")}`
      : "";

  return url
    ? [
        {
          key: `link:${url}`,
          label: numeric ? `Link #${input.replace(/^#/, "")}` : `Link ${url}`,
          url,
          linked: items.some((item) => item.url === url && item.linked),
        },
        ...items,
      ]
    : items;
}

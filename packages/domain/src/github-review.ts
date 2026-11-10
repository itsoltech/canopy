import type { github } from "@canopy/contracts";

export const reviewRevision = (pages: readonly github.PullRequestReviewDraft[]) =>
  pages.map((p) => p.revision).join(".");

export const reviewOutdated = (pages: readonly github.PullRequestReviewDraft[], head: string) =>
  pages.some((p) => (!!p.id && p.sha !== head) || p.comments.some((c) => c.outdated || c.comment?.sha !== head));

export const reviewComplete = (pages: readonly github.PullRequestReviewDraft[]) =>
  !!pages.length &&
  !pages.at(-1)?.page?.nextCursor &&
  pages.every((p) => p.page?.completeness === "complete" && !p.page.stale) &&
  pages.reduce((n, p) => n + p.comments.length, 0) === pages[0]?.totalCount;

export const anchorLabel = (c: { side: string; line: number; startSide: string; startLine: number }) =>
  c.startLine && c.startLine !== c.line
    ? `Lines ${c.startLine}–${c.line} (${c.side === "LEFT" ? "old" : "new"})`
    : `Line ${c.line} (${c.side === "LEFT" ? "old" : "new"})`;

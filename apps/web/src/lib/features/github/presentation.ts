import type { github } from "@canopy/contracts";
import { offlinePullRequestDetail, type PullRequestTone } from "@canopy/domain/github-pr";

type ReadInfo = Pick<github.PullRequestPageInfo, "stale" | "detail">;

export const isLinkedOffline = (read?: ReadInfo) => !!read?.stale && read.detail === offlinePullRequestDetail;

export function readStatus(read?: ReadInfo, offlineShown = false): string {
  if (!read?.stale) return read?.detail ?? "";

  // Linked gateways already identify the cached page when the computer is offline.
  if (isLinkedOffline(read)) return offlineShown ? "" : read.detail;

  return read.detail ? `Showing cached data. ${read.detail}` : "Showing cached data.";
}

export const toneClasses: Record<PullRequestTone, string> = {
  success: "text-emerald-700 dark:text-emerald-400",
  danger: "text-rose-700 dark:text-rose-400",
  warning: "text-amber-700 dark:text-amber-400",
  merged: "text-violet-700 dark:text-violet-400",
  muted: "text-zinc-500 dark:text-zinc-400",
};

export const pullRequestHref = (thread: string, id: string) =>
  `/threads/${encodeURIComponent(thread)}?pr=${encodeURIComponent(id)}`;

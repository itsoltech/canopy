import type { PullRequestTone } from "@canopy/domain/github-pr";

export const toneClasses: Record<PullRequestTone, string> = {
  success: "text-emerald-700 dark:text-emerald-400",
  danger: "text-rose-700 dark:text-rose-400",
  warning: "text-amber-700 dark:text-amber-400",
  merged: "text-violet-700 dark:text-violet-400",
  muted: "text-zinc-500 dark:text-zinc-400",
};

export const pullRequestHref = (thread: string, id: string) =>
  `/threads/${encodeURIComponent(thread)}?pr=${encodeURIComponent(id)}`;

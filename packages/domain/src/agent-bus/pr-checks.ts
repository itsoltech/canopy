import { Schema } from "effect";
import { PR_CHECK_EVENTS } from "../pr-check-watch.ts";

/**
 * Agent bus tools that watch the CI checks of a pull request linked to the thread (docs/agent-bus.md, "Checki CI";
 * docs/github.md §10). The gateway polls with the owner's GitHub account and tells the agent through a platform note
 * (a steer of the running turn, else a turn of its own, trigger pr_checks). Kept apart from tools.ts, which merges
 * them into AGENT_BUS_TOOLS.
 */

export const WatchPrChecks = Schema.Struct({
  pull_request: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).annotate({
    description:
      "A pull request linked to this thread: its URL (https://github.com/owner/repo/pull/123), owner/repo#123, " +
      "or #123 when one linked pull request has that number.",
  }),
  notify_on: Schema.optionalKey(
    Schema.Array(Schema.Literals(PR_CHECK_EVENTS))
      .check(Schema.isMinLength(1), Schema.isMaxLength(3))
      .annotate({
        description:
          "When you hear back: failure (a check failed, timed out or was cancelled), complete (every check of the head " +
          "finished), each (every check that finishes). Default [failure, complete].",
      }),
  ),
  timeout_minutes: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 1440 })).annotate({
      description: "Stop watching after this many minutes (default 60, max 1440).",
    }),
  ),
});

export const LinkPullRequest = Schema.Struct({
  pull_request: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).annotate({
    description:
      "A pull request to link to this thread: its URL (https://github.com/owner/repo/pull/123) or owner/repo#123.",
  }),
});

export const ListPrWatches = Schema.Struct({});

export const CancelPrWatch = Schema.Struct({
  watch_id: Schema.String.check(Schema.isUUID()).annotate({
    description: "watch_id from watch_pr_checks, list_pr_watches or a CI checks note.",
  }),
});

export const PR_CHECK_TOOLS = {
  link_pull_request: {
    name: "link_pull_request",
    description:
      "Link a GitHub pull request to this thread so watch_pr_checks can observe it. Use its URL from gh pr create " +
      "or owner/repo#123. Its base or head repository must match this thread's workspace or recorded Git remotes. This only changes " +
      "the Canopy thread link; it does not modify GitHub. If the user deliberately unlinked it, ask them to link " +
      "it in the thread's Pull requests panel instead. Safe to repeat when it is already linked.",
    args: LinkPullRequest,
    mutates: true,
  },
  watch_pr_checks: {
    name: "watch_pr_checks",
    description:
      "Watch the CI checks of a pull request linked to this thread and get a message here when they fail or finish, " +
      "instead of polling or sleeping. A pull request you open with gh pr create is linked automatically; if that " +
      "does not happen, link it with link_pull_request first. Uses the " +
      "user's GitHub account in Canopy. Follows new commits pushed to the pull request; ends when every check passes, " +
      "GitHub reports merge conflicts, the pull request is merged or closed, or after timeout_minutes. Messages name the failed checks with their " +
      "run ids (read a log with gh run view <run_id> --log-failed). Returns the current state and a watch_id when watching.",
    args: WatchPrChecks,
    mutates: true,
  },
  list_pr_watches: {
    name: "list_pr_watches",
    description: "This thread's CI check watches (watch_pr_checks): active and recently ended, with their state.",
    args: ListPrWatches,
    mutates: false,
  },
  cancel_pr_watch: {
    name: "cancel_pr_watch",
    description: "Stop a CI check watch of this thread. No further messages come from it.",
    args: CancelPrWatch,
    mutates: true,
  },
} as const;

export type PrCheckToolName = keyof typeof PR_CHECK_TOOLS;

export function isPrCheckTool(name: string): name is PrCheckToolName {
  return Object.hasOwn(PR_CHECK_TOOLS, name);
}

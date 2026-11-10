import type { github } from "@canopy/contracts";
import type { IconName } from "@canopy/ui/icons";

export type PullRequestTone = "success" | "danger" | "warning" | "merged" | "muted";

export interface PullRequestLook {
  label: string;
  icon: IconName;
  tone: PullRequestTone;
  rank: number;
}

const look = (label: string, icon: IconName, tone: PullRequestTone, rank = 4): PullRequestLook => ({
  label,
  icon,
  tone,
  rank,
});

export function checkLook(state: string): PullRequestLook {
  switch (state.toLowerCase()) {
    case "success":
      return look("Passed", "check-circle", "success", 3);
    case "failure":
    case "error":
      return look("Failed", "x-circle", "danger", 0);
    case "timed_out":
      return look("Timed out", "hourglass", "danger", 0);
    case "action_required":
      return look("Action required", "exclamation-circle", "warning", 0);
    case "in_progress":
    case "pending":
      return look("Running", "arrow-path", "warning", 1);
    case "queued":
    case "waiting":
    case "requested":
      return look("Queued", "clock", "warning", 2);
    case "cancelled":
      return look("Cancelled", "no-symbol", "muted");
    case "skipped":
      return look("Skipped", "arrow-turn-up-right", "muted");
    case "neutral":
      return look("Neutral", "minus", "muted");
    default:
      return look("Checks unavailable", "exclamation-circle", "muted");
  }
}

export function pullRequestLook(state: string): PullRequestLook {
  switch (state) {
    case "open":
      return look("Open", "git-fork", "success");
    case "merged":
      return look("Merged", "git-fork", "merged");
    case "closed":
      return look("Closed", "x-circle", "danger");
    case "draft":
      return look("Draft", "document-text", "muted");
    default:
      return look("Unavailable", "question-mark-circle", "muted");
  }
}

export function reviewerLook(state: string): PullRequestLook {
  switch (state) {
    case "approved":
      return look("Approved", "check-circle", "success");
    case "changes_requested":
      return look("Changes requested", "exclamation-circle", "danger");
    case "requested":
      return look("Requested", "clock", "muted");
    case "commented":
      return look("Commented", "chat-bubble-left", "muted");
    default:
      return look("Dismissed", "minus", "muted");
  }
}

export function timelineLook(kind: string, state: string, category = ""): PullRequestLook {
  if (category === "review") return reviewerLook(state);

  if (kind.includes("Check") || kind.includes("Status")) return checkLook(state);
  const icon = category === "commit" ? "git-fork" : "document-text";

  switch (kind) {
    case "MergedEvent":
      return pullRequestLook("merged");
    case "ClosedEvent":
      return pullRequestLook("closed");
    case "ReopenedEvent":
      return pullRequestLook("open");
    case "ConvertToDraftEvent":
      return pullRequestLook("draft");
    case "ReviewRequestedEvent":
      return reviewerLook("requested");
    default:
      return look(
        kind.replace(/Event$/, "").replace(/([a-z])([A-Z])/g, "$1 $2"),
        category === "comment" ? "chat-bubble-left" : icon,
        "muted",
      );
  }
}

export const sortedChecks = (checks: readonly github.PullRequestCheck[]) =>
  [...checks].sort((a, b) => checkLook(a.state).rank - checkLook(b.state).rank);

export function checksSummary(snapshot: github.PullRequestSnapshot) {
  const states = snapshot.checks.map((c) => checkLook(c.state));
  const failing = states.filter((s) => s.rank === 0).length;
  const running = states.filter((s) => s.rank === 1 || s.rank === 2).length;

  if (failing || running)
    return [failing && `${failing} failing`, running && `${running} running`].filter(Boolean).join(" · ");

  if (!states.length) return "No checks available";

  if (snapshot.completeness !== "complete" || states.length < (snapshot.summary?.checksCount ?? 0))
    return "Some checks unavailable";

  if (states.every((s) => s.label === "Passed")) return "All checks passed";

  return `${states.filter((s) => s.label === "Passed").length} passed · ${states.filter((s) => s.label !== "Passed").length} other`;
}

/** The original label colour is bounded hex; choose WCAG's higher-contrast foreground in either theme. */
export function labelColors(value: string) {
  const color = /^[0-9a-f]{6}$/i.test(value) ? value : "d4d4d8";

  const linear = [0, 2, 4]
    .map((i) => parseInt(color.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));

  const luminance = linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;

  return { background: `#${color}`, foreground: luminance > 0.179 ? "#000000" : "#ffffff" };
}

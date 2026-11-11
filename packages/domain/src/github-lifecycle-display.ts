import type { IconName } from "@canopy/ui/icons";

interface MergeBlocker {
  label: string;
  icon: IconName;
  detail: string;
}

/** Preserve GitHub's complete reason alongside its compact label, without inventing counts. */
export function mergeBlocker(detail: string): MergeBlocker {
  const text = detail.toLowerCase();

  if (text.includes("conflicts")) return { label: "Resolve conflicts", icon: "exclamation-triangle", detail };

  if (text.includes("review")) return { label: "Review required", icon: "chat-bubble-left", detail };

  if (text.includes("checks")) return { label: "Check results", icon: "check-circle", detail };

  if (text.includes("protection")) return { label: "Protected branch", icon: "lock-closed", detail };

  if (text.includes("behind")) return { label: "Update branch", icon: "arrow-path", detail };

  if (text.includes("draft")) return { label: "Draft", icon: "document-text", detail };

  if (text.includes("account")) return { label: "Check access", icon: "lock-closed", detail };

  return { label: "Check requirements", icon: "exclamation-triangle", detail };
}

export const methodSegmentLabel = (method: string) =>
  ({ MERGE: "Merge", SQUASH: "Squash", REBASE: "Rebase" })[method] ?? method;

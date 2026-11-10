import type { PullRequestTone } from "@canopy/domain/github-pr";
import type { Colors } from "../../ui/theme";

export const toneColor = (c: Colors, tone: PullRequestTone) =>
  ({
    success: c.success,
    danger: c.danger,
    warning: c.warning,
    merged: c.dark ? "#a78bfa" : "#6d28d9",
    muted: c.muted,
  })[tone];

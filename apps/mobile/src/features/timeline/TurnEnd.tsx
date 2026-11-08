import { Text, View } from "react-native";
import { Provider, type ui } from "@canopy/contracts";
import { formatDuration } from "@canopy/domain/format";
import { humanizeEnum, isEnumToken } from "@canopy/domain/humanize";
import { statusLook } from "@canopy/domain/status-look";
import type { IconName } from "@canopy/ui/icons";
import { Icon } from "../../ui/Icon";
import { font, styles, useColors } from "../../ui/theme";
import { useTone } from "../../ui/tone";
import { FailureNotice } from "./FailureNotice";

const REASONS = new Map([
  ["user", "by you"],
  ["interrupted", "by you"],
  ["drain", "worker draining"],
  ["worker_restart", "worker restarted"],
]);

/** A known reason in words; a machine token (`process_exit`) humanized; prose as it is. */
const said = (value: string) => REASONS.get(value) ?? (isEnumToken(value) ? humanizeEnum(value).toLowerCase() : value);

function detailOf(turn: ui.Turn): string {
  if (turn.status === "interrupted" && turn.interruptSource === "system")
    return `by the system: ${said(turn.interruptReason) || "unknown reason"}`;

  if (turn.status === "interrupted" && turn.interruptSource === "user") return "by you";

  return said(turn.interruptReason);
}

const AUTH_HINTS = new Map<Provider, string>([
  [Provider.CLAUDE, "Run claude login on the worker using this instance's CLI home, then retry."],
  [Provider.GROK, "Run grok login on the worker using this instance's CLI home, then retry."],
]);

/**
 * How a turn ended (web: TurnEnd). A failed turn explains its error; one that did not complete shows its status and
 * who stopped it. "Completed" is the norm, so it shows nothing.
 */
export function TurnEnd({ turn, provider }: { turn: ui.Turn; provider: Provider | undefined }) {
  const c = useColors();
  const look = statusLook(turn.status);
  const tone = useTone(look.tone).text;

  if (turn.status === "failed")
    return (
      <FailureNotice
        message={turn.error}
        code={turn.errorCode}
        classification={turn.errorClass}
        source={turn.errorSource}
        authHint={
          (provider !== undefined && AUTH_HINTS.get(provider)) ||
          "Sign in from provider settings, or run codex login on the worker using this instance's CLI home."
        }
      />
    );

  if (turn.status === "completed" || !["interrupted", "cancelled"].includes(turn.status)) return null;
  const icon: IconName = turn.status === "interrupted" ? "stop" : "minus";
  const detail = detailOf(turn);

  return (
    <View style={[styles.row, { flexWrap: "wrap", columnGap: 12, rowGap: 4 }]}>
      <View style={[styles.row, { gap: 4 }]}>
        <Icon name={icon} size={14} color={tone} />
        <Text style={[styles.meta, { fontFamily: font.medium, color: tone }]}>{look.label}</Text>
      </View>
      {detail ? <Text style={[styles.meta, { flexShrink: 1, color: c.muted }]}>{detail}</Text> : null}
    </View>
  );
}

/** The quiet footer of an ended turn: how long it ran (web: TurnDetails; copying and forking stay on the web). */
export function TurnDetails({ turn }: { turn: ui.Turn }) {
  const c = useColors();
  const start = turn.startedAt ? Number(turn.startedAt.seconds) * 1000 + turn.startedAt.nanos / 1e6 : undefined;
  const end = turn.completedAt ? Number(turn.completedAt.seconds) * 1000 + turn.completedAt.nanos / 1e6 : undefined;
  const took = start !== undefined && end !== undefined ? Math.round(end - start) : undefined;

  const duration = took !== undefined && took >= 0 ? formatDuration(took) : "";

  return (
    <Text
      accessibilityLabel={duration ? `Time the turn ran: ${duration}` : undefined}
      style={[styles.meta, { minHeight: styles.meta.lineHeight, color: c.muted, fontVariant: ["tabular-nums"] }]}
    >
      {duration}
    </Text>
  );
}

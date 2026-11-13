import { Pressable, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { formatSpan } from "@canopy/domain/format";
import { Rule } from "../../ui/Badge";
import { LiveText } from "../../ui/LiveText";
import { useAnchoredToggle } from "../../ui/feed-anchor";
import { font, styles, useColors } from "../../ui/theme";
import { useTone } from "../../ui/tone";
import { Chevron } from "../../ui/MotionViews";
import type { WorkSummary } from "./turn-plan";
import { ItemStatus } from "@canopy/contracts";
import type { IconName } from "@canopy/ui/icons";
import { Icon } from "../../ui/Icon";
import { ItemStatusIcon } from "./ItemStatusIcon";
import { activityHeader } from "./activity-header";
import { useLiveTime } from "../../ui/time";
import { useViewportVisibility } from "../../ui/viewport";

export type { WorkSummary } from "./turn-plan";

/** The clock updates just the label, including its clipped highlight copies. */
function WorkingTitle({ summary, starting }: { summary: WorkSummary; starting: boolean }) {
  const viewport = useViewportVisibility();
  const now = useLiveTime(viewport.visible && !starting && summary.startMs !== undefined);
  const span = summary.startMs === undefined ? undefined : Math.max(0, now - summary.startMs);
  const title = starting ? "Starting" : span === undefined ? "Working" : `Working for ${formatSpan(span)}`;

  return (
    <View
      ref={viewport.ref}
      onLayout={viewport.onLayout}
      collapsable={false}
      style={{ flexShrink: 0, maxWidth: "100%" }}
    >
      <LiveText
        containerStyle={{ flexShrink: 0, maxWidth: "100%" }}
        style={[styles.body, { fontFamily: font.medium, fontVariant: ["tabular-nums"] }]}
      >
        {title}
      </LiveText>
    </View>
  );
}

/**
 * The stable "Working for …" / "Worked for …" header of a segment's work (web: WorkFold): the time, what it is doing
 * or what it did, how much still runs, and a rule to the edge. The header keeps its place when it opens.
 */
export function WorkFold({
  summary,
  starting,
  open,
  onToggle,
}: {
  summary: WorkSummary;
  starting: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const c = useColors();
  const sky = useTone("sky").text;
  const { header, toggle } = useAnchoredToggle();
  const span = summary.spanMs;

  const label = starting
    ? "Starting"
    : summary.live
      ? span === undefined
        ? "Working"
        : "Working for"
      : summary.spanMs === undefined
        ? "Work"
        : "Worked for";

  const title = `${label}${!starting && span !== undefined ? ` ${formatSpan(span)}` : ""}`;
  const empty = !summary.live && summary.size === 0;
  const detail = summary.live && !starting ? summary.hint : summary.counts;

  const content = (
    <View style={[styles.row, { flex: 1, minWidth: 0, alignItems: "flex-start" }]}>
      <View style={{ width: 16, height: 24, justifyContent: "center" }}>
        {!empty && <Chevron open={open} color={c.faint} />}
      </View>
      {summary.live ? (
        <View style={{ flexDirection: "row", flexShrink: 1, minWidth: 0 }}>
          <WorkingTitle summary={summary} starting={starting} />
          {detail ? (
            <Text numberOfLines={1} style={[styles.body, { flexShrink: 1, color: c.faint }]}>
              {`  ${detail}`}
            </Text>
          ) : null}
        </View>
      ) : (
        <Text numberOfLines={1} style={[styles.body, { flexShrink: 1, color: c.faint, fontVariant: ["tabular-nums"] }]}>
          <Text style={{ fontFamily: font.medium, color: c.muted }}>{title}</Text>
          {detail ? `  ${detail}` : null}
        </Text>
      )}
      {!summary.live && summary.running > 0 && (
        <View style={[styles.row, { gap: 6, flexShrink: 0, height: 24 }]}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: sky }} />
          <Text style={[styles.body, { color: sky }]}>{summary.running} still running</Text>
        </View>
      )}
    </View>
  );

  return (
    <Animated.View ref={header} collapsable={false} style={[styles.row, { gap: 12 }]}>
      {empty ? (
        <View style={{ flexShrink: 1, paddingVertical: 10 }}>{content}</View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => toggle(onToggle)}
          style={{ flexShrink: 1, minHeight: 44, paddingVertical: 10 }}
        >
          {content}
        </Pressable>
      )}
      <Rule minWidth={16} />
    </Animated.View>
  );
}

/** A run of tools under its own header inside an open fold: "Read 1 file and ran 5 commands" (web: WorkGroup). */
export function WorkGroup({
  label,
  open,
  running,
  hint,
  icon,
  status,
  statusCount,
  onToggle,
}: {
  label: string;
  open: boolean;
  running: boolean;
  hint: string;
  icon: IconName;
  status: ItemStatus;
  statusCount: number;
  onToggle: () => void;
}) {
  const c = useColors();
  const { header, toggle } = useAnchoredToggle();

  const state =
    status === ItemStatus.FAILED
      ? "failed"
      : status === ItemStatus.DECLINED
        ? "declined"
        : status === ItemStatus.INTERRUPTED
          ? "interrupted"
          : status === ItemStatus.IN_PROGRESS
            ? "running"
            : "";

  return (
    <Animated.View ref={header} collapsable={false}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${state ? `${label}, ${statusCount} ${state}` : label}${running && !open ? `, ${hint}` : ""}`}
        accessibilityState={{ expanded: open }}
        onPress={() => toggle(onToggle)}
        style={({ pressed }) => [
          styles.row,
          activityHeader.row,
          open && activityHeader.open,
          { alignItems: "flex-start" },
          pressed && { backgroundColor: c.pressed },
        ]}
      >
        <View style={{ height: 24, justifyContent: "center" }}>
          <Chevron open={open} color={c.faint} />
        </View>
        <View style={{ height: 24, justifyContent: "center" }}>
          <Icon name={icon} color={c.icon} />
        </View>
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", gap: 8 }}>
          {running ? (
            <LiveText containerStyle={{ flex: 1, minWidth: 0 }} style={styles.work}>
              {label}
            </LiveText>
          ) : (
            <Text numberOfLines={1} style={[styles.work, { flex: 1, minWidth: 0, color: c.soft }]}>
              {label}
            </Text>
          )}
          {running && !open && (
            <Text numberOfLines={1} style={[styles.work, { flex: 1, minWidth: 0, color: c.faint }]}>
              {hint}
            </Text>
          )}
        </View>
        <View style={{ height: 24, width: 40, justifyContent: "center", alignItems: "flex-end", flexShrink: 0 }}>
          <ItemStatusIcon status={status} count={statusCount} />
        </View>
      </Pressable>
    </Animated.View>
  );
}

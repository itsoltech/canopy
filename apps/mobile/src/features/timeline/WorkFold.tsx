import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View, type HostInstance } from "react-native";
import { formatSpan } from "@canopy/domain/format";
import { Rule } from "../../ui/Badge";
import { LiveText } from "../../ui/LiveText";
import { useAnchoredToggle } from "../../ui/feed-anchor";
import { font, styles, useColors } from "../../ui/theme";
import { useTone } from "../../ui/tone";
import { Chevron } from "../../ui/MotionViews";
import type { WorkSummary } from "./turn-plan";

export type { WorkSummary } from "./turn-plan";

/** Ticks once a second while `live`; folds of ended turns have no timer. */
function useNow(live: boolean) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, [live]);

  return now;
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
  const now = useNow(summary.live);
  const header = useRef<HostInstance>(null);
  const toggle = useAnchoredToggle();
  const span = summary.live && summary.startMs !== undefined ? Math.max(0, now - summary.startMs) : summary.spanMs;

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
          <LiveText
            containerStyle={{ flexShrink: 0, maxWidth: "100%" }}
            style={[styles.body, { fontFamily: font.medium, fontVariant: ["tabular-nums"] }]}
          >
            {title}
          </LiveText>
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
    <View ref={header} collapsable={false} style={[styles.row, { gap: 12 }]}>
      {empty ? (
        <View style={{ flexShrink: 1, paddingVertical: 10 }}>{content}</View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={[title, detail].filter(Boolean).join(", ")}
          accessibilityState={{ expanded: open }}
          onPress={() => toggle(header.current, onToggle)}
          style={{ flexShrink: 1, minHeight: 44, paddingVertical: 10 }}
        >
          {content}
        </Pressable>
      )}
      <Rule minWidth={16} />
    </View>
  );
}

/** A run of tools under its own header inside an open fold: "Read 1 file and ran 5 commands" (web: WorkGroup). */
export function WorkGroup({
  label,
  open,
  running,
  onToggle,
}: {
  label: string;
  open: boolean;
  running: boolean;
  onToggle: () => void;
}) {
  const c = useColors();
  const header = useRef<HostInstance>(null);
  const toggle = useAnchoredToggle();

  return (
    <View ref={header} collapsable={false}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => toggle(header.current, onToggle)}
        style={[styles.row, { alignItems: "flex-start", minHeight: 44, paddingVertical: 10 }]}
      >
        <View style={{ height: 24, justifyContent: "center" }}>
          <Chevron open={open} color={c.faint} />
        </View>
        {running ? (
          <LiveText containerStyle={{ flex: 1 }} style={styles.body}>
            {label}
          </LiveText>
        ) : (
          <Text numberOfLines={1} style={[styles.body, { flex: 1, color: c.muted }]}>
            {label}
          </Text>
        )}
      </Pressable>
    </View>
  );
}

import { useEffect, useState } from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { ui } from "@canopy/contracts";
import { isActiveSubagent } from "@canopy/domain/subagents";
import { byActivity } from "@canopy/domain/thread-activity";
import { formatCount } from "@canopy/domain/format";
import { Chevron, Expand } from "../../ui/MotionViews";
import { styles, useColors } from "../../ui/theme";
import { useDevicePreferences } from "../settings/device-preferences";
import { SubagentLineageRow } from "./SubagentLineageRow";

/** Shared by thread details and the composer's subagent sheet. */
export function SubagentLineage({
  threads,
  onOpen,
  style,
}: {
  threads: readonly ui.Thread[];
  onOpen: (id: string) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const device = useDevicePreferences();
  const [now, setNow] = useState(Date.now);
  const agents = threads.filter((t) => t.spawnedByAgent && !t.deletedAt).sort(byActivity);
  const finished = agents.filter((t) => !isActiveSubagent(t));
  const main = device.values.showFinishedSubagents === "on" ? agents : agents.filter(isActiveSubagent);
  const open = device.values.finishedSubagentsExpanded === "on";

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);

    return () => clearInterval(timer);
  }, []);

  if (!agents.length) return null;

  return (
    <View style={style}>
      {main.map((thread) => (
        <SubagentLineageRow key={thread.id} thread={thread} now={now} onOpen={onOpen} />
      ))}
      {device.values.showFinishedSubagents === "off" && finished.length > 0 && (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            onPress={() => device.set("finishedSubagentsExpanded", open ? "off" : "on")}
            style={({ pressed }) => [
              styles.row,
              {
                minHeight: 44,
                paddingHorizontal: 8,
                borderRadius: 8,
                backgroundColor: pressed ? c.pressed : undefined,
              },
            ]}
          >
            <Text style={[styles.meta, { flex: 1, color: c.muted, fontVariant: ["tabular-nums"] }]}>
              {formatCount(finished.length)} finished
            </Text>
            <Chevron open={open} />
          </Pressable>
          <Expand open={open}>
            {finished.map((thread) => (
              <SubagentLineageRow key={thread.id} thread={thread} now={now} onOpen={onOpen} />
            ))}
          </Expand>
        </>
      )}
    </View>
  );
}

import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import {
  threadSyncComputerStatus,
  threadSyncComputerSummary,
  threadSyncLastTime,
  threadSyncThreads,
} from "@canopy/domain/thread-sync-display";
import { Icon } from "../../ui/Icon";
import { Chevron, Expand } from "../../ui/MotionViews";
import { styles, useColors } from "../../ui/theme";
import { ThreadSyncComputerDetails } from "./ThreadSyncComputerDetails";

export function ThreadSyncComputer({ computer }: { computer: ui.ThreadSyncComputer }) {
  const status = threadSyncComputerStatus(computer);
  const c = useColors();
  const [open, setOpen] = useState(false);

  return (
    <View style={{ minWidth: 0, gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={{ minHeight: 48, flexDirection: "row", alignItems: "flex-start", gap: 8 }}
      >
        <Chevron open={open} />
        <Icon name={status.icon} />
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <Text style={[styles.chrome, { color: c.text }]}>{computer.name}</Text>
          <Text style={[styles.workMeta, { color: c.muted }]}>{threadSyncComputerSummary(computer)}</Text>
          {!computer.reachable ? <Text style={[styles.workMeta, { color: c.muted }]}>Unreachable</Text> : null}
          <Text style={[styles.workMeta, { color: c.muted }]}>{threadSyncLastTime(computer.lastSyncedAtMs)}</Text>
        </View>
      </Pressable>
      <Expand open={open} style={{ gap: 8, minWidth: 0 }}>
        {computer.hostname !== computer.name ? (
          <Text selectable style={[styles.workMeta, { color: c.muted }]}>
            {computer.hostname}
          </Text>
        ) : null}
        {!computer.reachable ? (
          <Text style={[styles.workMeta, { color: c.muted }]}>Reconnect this computer to resume live updates.</Text>
        ) : null}
        {computer.syncingThreads || computer.pausedThreads ? <ThreadSyncComputerDetails computer={computer} /> : null}
        {computer.upToDateThreads ? (
          <Text style={[styles.workMeta, { color: c.muted }]}>
            {threadSyncThreads(computer.upToDateThreads)} up to date
          </Text>
        ) : null}
      </Expand>
    </View>
  );
}

import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import type { ThreadRowPlace } from "@canopy/domain/git-heads";
import { threadRowMarks } from "@canopy/ui/thread-row";
import { Icon } from "../../ui/Icon";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { styles, useColors } from "../../ui/theme";
import { useSidebarTypography } from "./sidebar-scale";

/**
 * The row's last line, as on web (docs/threads.md, "Wiersz wątku"): computer and place take at most 2/5, the live
 * branch the rest. Long branch names lose their middle, so the type prefix and the distinguishing end stay visible;
 * the row's accessibility label carries the full name.
 */
export function SidebarThreadMeta({
  thread,
  worker,
  place,
}: {
  thread: ui.Thread;
  worker?: ui.Worker;
  place: ThreadRowPlace;
}) {
  const c = useColors();
  const type = useSidebarTypography();

  return (
    <View style={[styles.row, { gap: 8 }]}>
      <Icon name="computer-desktop" size={16} color={worker?.online ? c.muted : c.faint} />
      <Text
        numberOfLines={1}
        style={[
          type.meta,
          { minWidth: 0, color: c.muted },
          place.branch ? { flexShrink: 1, maxWidth: "40%" } : { flex: 1 },
        ]}
      >
        {worker?.name ?? "Unknown worker"}
        {place.place ? ` · ${place.place}` : ""}
      </Text>
      {place.branch ? (
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Icon name="git-fork" size={14} color={c.muted} />
          <Text numberOfLines={1} ellipsizeMode="middle" style={[type.meta, { flex: 1, minWidth: 0, color: c.muted }]}>
            {place.branch}
          </Text>
        </View>
      ) : null}
      {thread.goalStatus ? <Icon name="flag" size={16} /> : null}
      <ProviderIcon provider={thread.provider} size={threadRowMarks.icon} opacity={threadRowMarks.providerOpacity} />
    </View>
  );
}

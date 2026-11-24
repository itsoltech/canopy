import { View } from "react-native";
import type { ReactNode } from "react";
import type { ui } from "@canopy/contracts";
import { workState } from "@canopy/domain/thread-activity";
import { threadRowMarks } from "@canopy/ui/thread-row";
import { Icon } from "../../ui/Icon";
import { ProjectMark } from "../../ui/ProjectMark";
import { WorkingSpinner } from "../../ui/WorkingSpinner";
import { useColors } from "../../ui/theme";

/** Activity replaces the project mark without moving the other columns. */
export function SidebarActivity({
  thread,
  project,
  away = false,
  size = threadRowMarks.slot,
  idle,
  groupedProject = false,
  snoozed = false,
  dimmed,
}: {
  thread: ui.Thread;
  project?: ui.Project;
  away?: boolean;
  size?: number;
  idle?: ReactNode;
  groupedProject?: boolean;
  snoozed?: boolean;
  dimmed?: boolean;
}) {
  const c = useColors();
  const state = workState(thread);
  const visible = away || !groupedProject || state === "needs" || state === "asks" || state === "background";
  const mark = idle ?? <ProjectMark project={project} size={threadRowMarks.icon} muted={dimmed} />;

  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      {!visible ? null : away ? (
        <Icon name="link" size={threadRowMarks.icon} color={c.faint} />
      ) : snoozed ? (
        mark
      ) : state === "starting" || state === "running" ? (
        <WorkingSpinner color={c.working.indicator} />
      ) : state === "needs" || state === "asks" ? (
        <Icon name="hand-raised" size={threadRowMarks.icon} color={state === "needs" ? c.warning : c.agent} />
      ) : state === "background" ? (
        <Icon name="bolt" size={threadRowMarks.icon} color={c.working.indicator} />
      ) : (
        mark
      )}
    </View>
  );
}

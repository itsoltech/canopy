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
}: {
  thread: ui.Thread;
  project?: ui.Project;
  away?: boolean;
  size?: number;
  idle?: ReactNode;
}) {
  const c = useColors();
  const state = workState(thread);

  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      {away ? (
        <Icon name="link" size={threadRowMarks.icon} color={c.faint} />
      ) : state === "starting" || state === "running" ? (
        <WorkingSpinner color={c.working.indicator} />
      ) : state === "needs" || state === "asks" ? (
        <Icon name="hand-raised" size={threadRowMarks.icon} color={state === "needs" ? c.warning : c.agent} />
      ) : state === "background" ? (
        <Icon name="bolt" size={threadRowMarks.icon} color={c.working.indicator} />
      ) : (
        (idle ?? <ProjectMark name={project?.name ?? "?"} kind={project?.kind} size={threadRowMarks.slot} />)
      )}
    </View>
  );
}

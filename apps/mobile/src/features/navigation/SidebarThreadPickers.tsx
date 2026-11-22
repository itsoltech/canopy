import { threadSortModes } from "@canopy/domain/thread-order";
import { PickerSheet } from "../../ui/Picker";
import { ProjectMark } from "../../ui/ProjectMark";
import { useDevicePreferences } from "../settings/device-preferences";
import { useProjectDetails } from "../computers/project-details";
import type { useSidebarThreads } from "./useSidebarThreads";

interface PickerVisibility {
  visible: boolean;
  onClose: () => void;
}

export function SidebarSort({ visible, onClose }: PickerVisibility) {
  const device = useDevicePreferences();
  const { threadSortMode } = device.view;

  return (
    <PickerSheet
      title="Sort threads"
      visible={visible}
      onClose={onClose}
      value={threadSortMode}
      note={
        threadSortMode === "custom"
          ? "Hold a thread to drag within its section. Drop at the top to pin. Use Thread actions to move without dragging."
          : undefined
      }
      onSelect={(mode) => device.setView({ threadSortMode: mode })}
      sections={[{ options: [...threadSortModes] }]}
    />
  );
}

export function SidebarProjectFilter({
  navigation,
  projectId,
  visible,
  onClose,
}: PickerVisibility & {
  navigation: ReturnType<typeof useSidebarThreads>;
  projectId: string;
}) {
  const details = useProjectDetails();
  const projects = navigation.choices.filter((project) => !project.archivedAt);

  return (
    <PickerSheet
      title="Filter by project"
      visible={visible}
      onClose={onClose}
      value={projectId}
      onSelect={navigation.setProjectId}
      search={projects.length > 6 ? "Search projects" : undefined}
      sections={[
        {
          options: [{ value: "", label: "All projects", icon: "folder-open" }],
        },
        {
          options: projects.map((project) => {
            const away = navigation.projectAway(project);

            return {
              value: project.id,
              label: project.name,
              leading: <ProjectMark name={project.name} kind={project.kind} />,
              badge: away ? "Offline" : undefined,
              description: [away, details.detail(project)].filter(Boolean).join(" · "),
              keywords: project.aliases.join(" "),
              muted: Boolean(away),
            };
          }),
        },
      ]}
    />
  );
}

import { threadSortModes } from "@canopy/domain/thread-order";
import { PickerSheet } from "../../ui/Picker";
import { ProjectMark } from "../../ui/ProjectMark";
import { useDevicePreferences } from "../settings/device-preferences";
import { useProjectDetails } from "../computers/project-details";
import type { useSidebarThreads } from "./useSidebarThreads";

export function SidebarOptions({
  navigation,
  projectId,
  visible,
  onClose,
}: {
  navigation: ReturnType<typeof useSidebarThreads>;
  projectId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const device = useDevicePreferences();
  const details = useProjectDetails();

  return (
    <PickerSheet
      title="Thread options"
      visible={visible}
      onClose={onClose}
      search={navigation.choices.length > 6 ? "Search options" : undefined}
      note={
        navigation.sortMode === "custom"
          ? "Hold a thread to drag within its section. Drop at the top to pin. Use Thread actions to move without dragging."
          : undefined
      }
      onSelect={(value: string) => {
        const mode = threadSortModes.find((option) => `sort:${option.value}` === value);

        if (mode) device.setView({ threadSortMode: mode.value });
        else navigation.setProjectId(value.slice("project:".length));
      }}
      sections={[
        {
          title: "Sort threads",
          options: threadSortModes.map((mode) => ({
            value: `sort:${mode.value}`,
            label: mode.label,
            badge: navigation.sortMode === mode.value ? "Selected" : undefined,
          })),
        },
        {
          title: "Show threads from",
          options: [
            {
              value: "project:",
              label: "All projects",
              icon: "folder-open",
              badge: !projectId ? "Selected" : undefined,
            },
          ],
        },
        {
          options: navigation.choices
            .filter((p) => !p.archivedAt)
            .map((p) => ({
              value: `project:${p.id}`,
              label: p.name,
              leading: <ProjectMark name={p.name} kind={p.kind} />,
              badge: projectId === p.id ? "Selected" : navigation.projectAway(p) ? "Offline" : undefined,
              description: [navigation.projectAway(p), details.detail(p)].filter(Boolean).join(" · "),
              keywords: p.aliases.join(" "),
              muted: Boolean(navigation.projectAway(p)),
            })),
        },
      ]}
    />
  );
}

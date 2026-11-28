import { Pressable, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { projectAwayReason } from "@canopy/domain/linked-snapshot";
import { useOverview } from "../../state/overview";
import { Icon } from "../../ui/Icon";
import { ProjectMark } from "../../ui/ProjectMark";
import { useSkeleton } from "../../ui/Skeleton";
import { font, useColors, useTypography } from "../../ui/theme";
import { useProjectDetails } from "../computers/project-details";

export function ProjectSettingsRow({ project, onPress }: { project: ui.Project; onPress: () => void }) {
  const c = useColors();
  const type = useTypography();
  const loading = useSkeleton();
  const { workers, computers } = useOverview();
  const details = useProjectDetails();
  const away = projectAwayReason(project, workers, computers);
  const count = project.workspaces.length;

  const names = [
    ...new Set(project.workspaces.map((ws) => workers.find((w) => w.id === ws.workerId)?.name ?? "Unknown worker")),
  ];

  const paths = [...new Set(project.workspaces.map((ws) => ws.rootPath))].filter(Boolean).join(" · ");

  const metadata = count
    ? [
        `${count} ${count === 1 ? "workspace" : "workspaces"}`,
        names.join(" · "),
        computers.length ? details.places(project) : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "No workspaces yet";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={project.name}
      accessibilityHint="Open project settings"
      accessibilityValue={{ text: [metadata, paths, away].filter(Boolean).join(" · ") }}
      disabled={loading}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        minHeight: 48,
        marginHorizontal: -12,
        marginVertical: -10,
        paddingHorizontal: 12,
        paddingVertical: 4,
        opacity: away ? 0.55 : 1,
        backgroundColor: pressed ? c.pressed : "transparent",
      })}
    >
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexShrink: 0 }}>
        <ProjectMark project={project} size={24} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={[type.chrome, { color: c.text, fontFamily: font.medium }]}>
          {project.name}
        </Text>
        <Text numberOfLines={1} style={[type.meta, { color: c.muted }]}>
          {metadata}
        </Text>
        {!!paths && (
          <Text numberOfLines={1} ellipsizeMode="middle" style={[type.meta, { color: c.muted }]}>
            {paths}
          </Text>
        )}
        {!!away && (
          <Text numberOfLines={2} style={[type.meta, { color: c.muted }]}>
            {away}
          </Text>
        )}
      </View>
      <Icon name="chevron-right" color={c.faint} />
    </Pressable>
  );
}

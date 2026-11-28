import { Pressable, Text, View } from "react-native";
import type { IconName } from "@canopy/ui/icons";
import { Icon } from "../../ui/Icon";
import { font, useColors, useTypography } from "../../ui/theme";

export type ProjectSource = "directory" | "init" | "clone" | "github";

export const projectSources: { value: ProjectSource; title: string; description: string; icon: IconName }[] = [
  {
    value: "directory",
    title: "Existing directory",
    description: "Use a directory already on this worker.",
    icon: "folder",
  },
  { value: "init", title: "New project", description: "Create a directory with a Git repository.", icon: "plus" },
  { value: "github", title: "GitHub repository", description: "Clone a repository from GitHub.", icon: "git-branch" },
  { value: "clone", title: "Git URL", description: "Clone a repository from a Git URL.", icon: "link" },
];

export function ProjectSourceChoices({
  capable,
  onChoose,
}: {
  capable: boolean;
  onChoose: (kind: ProjectSource) => void;
}) {
  return (
    <View style={{ gap: 4 }}>
      {projectSources.map((source) => (
        <ProjectChoiceRow
          key={source.value}
          title={source.title}
          icon={source.icon}
          description={
            source.value !== "directory" && !capable
              ? "Update Canopy on this worker to use this source."
              : source.description
          }
          disabled={source.value !== "directory" && !capable}
          onPress={() => onChoose(source.value)}
        />
      ))}
    </View>
  );
}

export function ProjectChoiceRow({
  title,
  description,
  icon,
  disabled,
  onPress,
}: {
  title: string;
  description?: string;
  icon: IconName;
  disabled?: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  const type = useTypography();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={description}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        minHeight: 48,
        paddingHorizontal: 12,
        paddingVertical: 4,
        borderRadius: 10,
        opacity: disabled ? 0.45 : 1,
        backgroundColor: pressed ? c.pressed : "transparent",
      })}
    >
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: c.well,
        }}
      >
        <Icon name={icon} size={16} color={c.icon} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={2} style={[type.chrome, { color: c.text, fontFamily: font.medium }]}>
          {title}
        </Text>
        {!!description && <Text style={[type.meta, { color: c.muted }]}>{description}</Text>}
      </View>
      <Icon name="chevron-right" size={14} color={c.faint} />
    </Pressable>
  );
}

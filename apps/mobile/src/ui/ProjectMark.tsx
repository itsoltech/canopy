import { Image, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { palette } from "@canopy/ui";
import { projectMark, projectMarkColors } from "@canopy/ui/thread-row";
import { useColors } from "./theme";

export function ProjectMark({
  project,
  name = project?.name ?? "?",
  color = project?.color ?? "",
  size = 18,
}: {
  project: Pick<ui.Project, "name" | "color" | "kind" | "imageBase64"> | undefined;
  name?: string;
  color?: string;
  size?: number;
}) {
  const c = useColors();
  const { imageBase64, kind } = project ?? {};

  if (kind !== "scratch" && imageBase64)
    return (
      <Image
        accessible={false}
        source={{ uri: `data:image/png;base64,${imageBase64}` }}
        style={{ width: size, height: size, borderRadius: 2 }}
        resizeMode="cover"
        fadeDuration={0}
      />
    );

  const mark = projectMark(name);
  const tone = palette[mark.tone];
  const fill = mark.tone === "zinc" ? c.projectNeutral.fill : tone[mark.fill];
  const text = mark.tone === "zinc" ? c.projectNeutral.text : tone[c.dark ? mark.dark : mark.light];
  const custom = projectMarkColors(color);
  const backgroundColor = custom?.fill ?? `${fill}${Math.round(mark.opacity * 255).toString(16)}`;

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: kind === "scratch" ? "transparent" : backgroundColor,
        borderStyle: kind === "scratch" ? "dashed" : "solid",
        borderWidth: kind === "scratch" ? 1 : 0,
        borderColor: c.muted,
      }}
    >
      {kind !== "scratch" && (
        <Text
          style={{
            fontSize: size / 2,
            lineHeight: size / 2 + 2,
            fontWeight: "700",
            fontFamily: "monospace",
            color: custom?.text ?? text,
          }}
        >
          {mark.initials}
        </Text>
      )}
    </View>
  );
}

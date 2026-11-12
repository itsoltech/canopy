import { Text, View } from "react-native";
import { palette } from "@canopy/ui";
import { projectMark } from "@canopy/ui/thread-row";
import { useColors } from "./theme";

export function ProjectMark({ name, kind, size = 18 }: { name: string; kind?: string; size?: number }) {
  const c = useColors();
  const mark = projectMark(name);
  const color = palette[mark.tone];
  const fill = mark.tone === "zinc" ? c.projectNeutral.fill : color[mark.fill];
  const text = mark.tone === "zinc" ? c.projectNeutral.text : color[c.dark ? mark.dark : mark.light];

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: kind === "scratch" ? "transparent" : `${fill}${Math.round(mark.opacity * 255).toString(16)}`,
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
            color: text,
          }}
        >
          {mark.initials}
        </Text>
      )}
    </View>
  );
}

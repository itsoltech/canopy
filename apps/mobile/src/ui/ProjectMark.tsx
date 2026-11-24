import { Image, Text, View } from "react-native";
import { FilterImage } from "react-native-svg/filter-image";
import type { ui } from "@canopy/contracts";
import { palette } from "@canopy/ui";
import { projectMark, projectMarkColors } from "@canopy/ui/thread-row";
import { useColors } from "./theme";

const snoozedSaturation = 0.3;

function desaturate(color: string) {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  const gray = red * 0.213 + green * 0.715 + blue * 0.072;

  const channels = [red, green, blue].map((channel) =>
    Math.round(gray + snoozedSaturation * (channel - gray))
      .toString(16)
      .padStart(2, "0"),
  );

  return `#${channels.join("")}${color.slice(7)}`;
}

export function ProjectMark({
  project,
  name = project?.name ?? "?",
  color = project?.color ?? "",
  size = 18,
  muted,
}: {
  project: Pick<ui.Project, "name" | "color" | "kind" | "imageBase64"> | undefined;
  name?: string;
  color?: string;
  size?: number;
  muted?: boolean;
}) {
  const c = useColors();
  const { imageBase64, kind } = project ?? {};

  if (kind !== "scratch" && imageBase64) {
    const source = { uri: `data:image/png;base64,${imageBase64}` };
    const style = { width: size, height: size, borderRadius: 2, opacity: muted ? 0.65 : 1 };

    if (muted !== undefined)
      return (
        <FilterImage
          accessible={false}
          source={source}
          style={style}
          filters={muted ? [{ name: "feColorMatrix", type: "saturate", values: [snoozedSaturation] }] : undefined}
          resizeMode="cover"
        />
      );

    return <Image accessible={false} source={source} style={style} resizeMode="cover" fadeDuration={0} />;
  }

  const mark = projectMark(name);
  const tone = palette[mark.tone];
  const fill = mark.tone === "zinc" ? c.projectNeutral.fill : tone[mark.fill];
  const text = mark.tone === "zinc" ? c.projectNeutral.text : tone[c.dark ? mark.dark : mark.light];
  const custom = projectMarkColors(color);
  const backgroundColor = custom?.fill ?? `${fill}${Math.round(mark.opacity * 255).toString(16)}`;
  const ink = custom?.text ?? text;

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: kind === "scratch" ? "transparent" : muted ? desaturate(backgroundColor) : backgroundColor,
        opacity: muted ? 0.65 : 1,
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
            color: muted ? desaturate(ink) : ink,
          }}
        >
          {mark.initials}
        </Text>
      )}
    </View>
  );
}

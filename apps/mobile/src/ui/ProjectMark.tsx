import { Text, View } from "react-native";
import { palette } from "@canopy/ui";
import { useColors } from "./theme";
export function ProjectMark({ name, kind }: { name: string; kind?: string }) {
  const c = useColors();
  const tones = [
    "emerald",
    "rose",
    "amber",
    "sky",
    "violet",
    "fuchsia",
    "cyan",
    "lime",
    "zinc",
  ] as const;
  const tone =
    tones[
      [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) %
        tones.length
    ]!;
  const color = palette[tone];
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const initials = (
    words.length > 1
      ? `${words[0]![0]}${words[1]![0]}`
      : (words[0] ?? "?").slice(0, 2)
  ).toUpperCase();
  return (
    <View
      style={{
        width: 18,
        height: 18,
        borderRadius: 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: kind === "scratch" ? "transparent" : `${color[500]}26`,
        borderStyle: kind === "scratch" ? "dashed" : "solid",
        borderWidth: kind === "scratch" ? 1 : 0,
        borderColor: c.muted,
      }}
    >
      {kind !== "scratch" && (
        <Text
          style={{
            fontSize: 9,
            lineHeight: 11,
            fontWeight: "700",
            fontFamily: "monospace",
            color: color[c.dark ? 400 : 700],
          }}
        >
          {initials}
        </Text>
      )}
    </View>
  );
}

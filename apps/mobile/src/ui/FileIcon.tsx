import Svg, { Path } from "react-native-svg";
import { fileGlyph } from "@canopy/ui/file-icons";
import { Icon } from "./Icon";
import { useColors } from "./theme";

export function FileIcon({ path }: { path: string }) {
  const { dark, muted } = useColors();
  const glyph = fileGlyph(path);
  const color = (dark ? glyph.dark : glyph.light) || muted;

  return glyph.path ? (
    <Svg width={16} height={16} viewBox="0 0 24 24" accessible={false}>
      <Path d={glyph.path} fill={color} />
    </Svg>
  ) : (
    <Icon name={glyph.icon} color={color} />
  );
}

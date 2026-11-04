import Svg, { Path } from "react-native-svg";
import { icons, iconStyle, type IconName } from "@canopy/ui/icons";
import { useColors } from "./theme";

export function Icon({
  name,
  size = 16,
  color,
  label,
}: {
  name: IconName;
  size?: number;
  color?: string;
  label?: string;
}) {
  const c = useColors();
  const paths = icons[name];
  const ink = color ?? c.muted;

  return (
    <Svg
      width={size}
      height={size}
      viewBox={iconStyle.viewBox}
      fill="none"
      stroke={ink}
      strokeWidth={iconStyle.strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessibilityLabel={label}
      accessible={Boolean(label)}
    >
      {paths.map((d) => (
        <Path key={d} d={d} />
      ))}
    </Svg>
  );
}

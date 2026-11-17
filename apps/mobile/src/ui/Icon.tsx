import Svg, { Path } from "react-native-svg";
import { icons, iconStyle, filledIcons, type IconName } from "@canopy/ui/icons";
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
  const filled = filledIcons.has(name);

  return (
    <Svg
      width={size}
      height={size}
      viewBox={iconStyle.viewBox}
      fill="none"
      stroke={filled ? "none" : ink}
      strokeWidth={iconStyle.strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessibilityLabel={label}
      accessible={Boolean(label)}
    >
      {paths.map((d) => (
        <Path key={d} d={d} fill={filled ? ink : "none"} fillRule="evenodd" />
      ))}
    </Svg>
  );
}

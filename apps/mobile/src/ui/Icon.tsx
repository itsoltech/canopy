import Svg, { Path } from "react-native-svg";
import { icons, type IconName } from "@canopy/ui/icons";
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
  const icon = icons[name];
  const ink = color ?? c.muted;

  return (
    <Svg
      width={size}
      height={size}
      viewBox={icon.viewBox}
      fill={icon.fill === "none" ? "none" : ink}
      stroke={icon.stroke ? ink : undefined}
      strokeWidth={icon.strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessibilityLabel={label}
      accessible={Boolean(label)}
    >
      {icon.paths.map((p) => (
        <Path
          key={p.d}
          d={p.d}
          fillRule={p.evenodd ? "evenodd" : undefined}
          clipRule={p.evenodd ? "evenodd" : undefined}
        />
      ))}
    </Svg>
  );
}

import Svg, { Path } from "react-native-svg";
import { icons, lineIcons, type IconName } from "@canopy/ui/icons";
import { useColors } from "./theme";

function isLineIcon(name: IconName): name is keyof typeof lineIcons {
  return name in lineIcons;
}

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
  const line = isLineIcon(name);

  return (
    <Svg
      width={size}
      height={size}
      viewBox={line ? "-2 -2 28 28" : "0 0 16 16"}
      fill={line ? "none" : (color ?? c.muted)}
      stroke={line ? (color ?? c.muted) : undefined}
      strokeWidth={line ? 2 : undefined}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessibilityLabel={label}
      accessible={Boolean(label)}
    >
      {isLineIcon(name)
        ? lineIcons[name].map((d) => <Path key={d} d={d} />)
        : icons[name].map((p) => (
            <Path
              key={p.d}
              d={p.d}
              fillRule={"evenodd" in p ? "evenodd" : undefined}
              clipRule={"evenodd" in p ? "evenodd" : undefined}
            />
          ))}
    </Svg>
  );
}

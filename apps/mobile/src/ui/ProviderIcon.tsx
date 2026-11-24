import Svg, { Path } from "react-native-svg";
import { Provider } from "@canopy/contracts";
import { providerColors, providerPaths } from "@canopy/ui/provider-icons";
import { isProviderKey } from "@canopy/ui/providers";
import { harnessName } from "@canopy/domain/provider-instances";
import { useColors } from "./theme";

export function ProviderIcon({
  provider,
  size = 14,
  opacity = 1,
}: {
  provider: Provider;
  size?: number;
  opacity?: number;
}) {
  const c = useColors();
  const key = Provider[provider];

  if (!isProviderKey(key)) return null;

  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={key === "CLAUDE" ? providerColors.CLAUDE : providerColors[c.dark ? "dark" : "light"]}
      opacity={opacity}
      accessibilityLabel={harnessName(provider)}
    >
      <Path d={providerPaths[key]} />
    </Svg>
  );
}

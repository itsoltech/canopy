import { Text, View } from "react-native";
import type { ProviderUsageSnapshot } from "@canopy/contracts";
import { activeUsageWindows, usageBillingNotice } from "@canopy/domain/provider-usage";
import { useColors } from "../../ui/theme";
import { UsageMeter } from "./UsageMeter";
import { useUsageTypography } from "./usage-typography";

/** Plan windows and billing notices; settings can add the steady-use reference. */
export function UsageMeters({
  usage,
  now,
  showPace = false,
}: {
  usage: ProviderUsageSnapshot | undefined;
  now: number;
  showPace?: boolean;
}) {
  const c = useColors();
  const type = useUsageTypography();
  const windows = activeUsageWindows(usage, now);
  const billing = usageBillingNotice(usage, now);

  if (!windows.length && !billing) return null;

  return (
    <View style={{ gap: 8, minWidth: 0 }}>
      {windows.map((window) => (
        <UsageMeter key={`${window.key}:${window.windowMinutes}`} window={window} now={now} showPace={showPace} />
      ))}
      {billing ? (
        <Text accessibilityLiveRegion="polite" style={[type.meta, { color: c.warning }]}>
          {billing}
        </Text>
      ) : null}
    </View>
  );
}

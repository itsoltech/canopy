import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { ProviderUsageSnapshot } from "@canopy/contracts";
import { usageWarnings } from "@canopy/domain/provider-usage";
import { styles } from "../../ui/theme";
import { useTone } from "../../ui/tone";

export function UsageWarning({ usage }: { usage?: ProviderUsageSnapshot }) {
  const [now, setNow] = useState(Date.now());
  const color = useTone("amber").text;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);

    return () => clearInterval(timer);
  }, []);
  const warnings = usageWarnings(usage, now);

  if (!warnings.length) return null;

  return (
    <View accessibilityLiveRegion="polite" style={{ gap: 2, paddingHorizontal: 6, paddingBottom: 4 }}>
      {warnings.map((warning) => (
        <Text key={warning} style={[styles.meta, { color, fontVariant: ["tabular-nums"] }]}>
          {warning}
        </Text>
      ))}
      <Text style={[styles.meta, { color }]}>Check usage in provider settings.</Text>
    </View>
  );
}

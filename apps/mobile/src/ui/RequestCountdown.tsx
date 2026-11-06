import { useEffect, useState } from "react";
import { Text, type StyleProp, type TextStyle } from "react-native";
import { timestampMs, type Timestamp } from "@bufbuild/protobuf/wkt";
import { styles, useColors } from "./theme";

/**
 * Time left to answer a request with a known deadline, as on the web: "Expires in 1:45", amber in the last 25 s,
 * "Expiring…" at zero until the gateway marks the request expired (the gateway decides, never this clock).
 * Ticks from the phone's clock once a second. The line keeps its size, so nothing moves when it changes.
 */
export function RequestCountdown({
  expiresAt,
  pending,
  style,
}: {
  expiresAt: Timestamp | undefined;
  pending: boolean;
  style?: StyleProp<TextStyle>;
}) {
  const c = useColors();
  const [now, setNow] = useState(Date.now);
  const deadline = expiresAt ? timestampMs(expiresAt) : undefined;
  const active = deadline !== undefined && pending;

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, [active]);

  if (!active) return null;
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));

  return (
    <Text
      // Seconds never announce over what a screen reader is reading.
      accessibilityLiveRegion="none"
      numberOfLines={1}
      style={[
        styles.caption,
        { minWidth: 112, fontVariant: ["tabular-nums"], color: seconds <= 25 ? c.warning : c.muted },
        style,
      ]}
    >
      {seconds > 0 ? `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "Expiring…"}
    </Text>
  );
}

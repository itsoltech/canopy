import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { timestampDate, type Timestamp } from "@bufbuild/protobuf/wkt";
import { useColors, useTypography } from "../../ui/theme";

export function ConfirmationCountdown({ expiresAt }: { expiresAt?: Timestamp }) {
  const [now, setNow] = useState(() => Date.now());

  const c = useColors(),
    type = useTypography();

  const remaining = expiresAt ? Math.max(0, Math.ceil((timestampDate(expiresAt).getTime() - now) / 1000)) : 0;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, []);

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text style={[type.meta, { flex: 1, color: c.muted }]}>
        {remaining ? "Confirm within 60 s" : "Confirmation expired"}
      </Text>
      <Text
        accessible={false}
        style={[type.meta, { width: 44, color: c.muted, textAlign: "right", fontVariant: ["tabular-nums"] }]}
      >
        {remaining} s
      </Text>
    </View>
  );
}

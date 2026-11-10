import { useEffect, useState } from "react";
import { Text } from "react-native";
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
    <Text style={[type.meta, { minHeight: 20, minWidth: 160, color: c.muted, fontVariant: ["tabular-nums"] }]}>
      {remaining ? `Confirm within ${remaining} s` : "Confirmation expired"}
    </Text>
  );
}

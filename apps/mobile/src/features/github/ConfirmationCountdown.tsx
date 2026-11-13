import { Text } from "react-native";
import { timestampDate, type Timestamp } from "@bufbuild/protobuf/wkt";
import { useColors, useTypography } from "../../ui/theme";
import { useTimeLabel } from "../../ui/time";

export function ConfirmationCountdown({ expiresAt }: { expiresAt?: Timestamp }) {
  const c = useColors(),
    type = useTypography();

  const deadline = expiresAt ? timestampDate(expiresAt).getTime() : 0;

  const label = useTimeLabel((now) => {
    const remaining = Math.max(0, Math.ceil((deadline - now) / 1000));

    return remaining ? `Confirm within ${remaining} s` : "Confirmation expired";
  }, !!expiresAt);

  return (
    <Text style={[type.meta, { minHeight: 20, minWidth: 160, color: c.muted, fontVariant: ["tabular-nums"] }]}>
      {label}
    </Text>
  );
}

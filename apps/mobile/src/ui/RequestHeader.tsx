import type { ReactNode } from "react";
import { View } from "react-native";
import type { Timestamp } from "@bufbuild/protobuf/wkt";
import { RequestCountdown } from "./RequestCountdown";
import { styles } from "./theme";

/** Keep a known deadline beside the title, or below it when the card is narrow. */
export function RequestHeader({
  expiresAt,
  pending,
  children,
}: {
  expiresAt: Timestamp | undefined;
  pending: boolean;
  children: ReactNode;
}) {
  return (
    <View style={[styles.row, { flexWrap: "wrap", alignItems: "flex-start" }]}>
      <View style={{ minWidth: 0, flexBasis: 180, flexGrow: 1, flexShrink: 1 }}>{children}</View>
      {expiresAt && (
        <View style={{ minHeight: 24, justifyContent: "center", marginLeft: "auto" }}>
          <RequestCountdown expiresAt={expiresAt} pending={pending} />
        </View>
      )}
    </View>
  );
}

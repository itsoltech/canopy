import { ItemStatus } from "@canopy/contracts";
import { StyleSheet } from "react-native";
import type { Colors } from "../../ui/theme";

/** Matches the web activity header without changing its insets when status changes. */
export const activityHeader = StyleSheet.create({
  row: { borderLeftWidth: 2, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 8, minHeight: 44 },
});

export function activitySurface(status: ItemStatus, c: Colors) {
  const unsuccessful =
    status === ItemStatus.FAILED || status === ItemStatus.DECLINED || status === ItemStatus.INTERRUPTED;

  return {
    borderColor: unsuccessful ? `${c.danger}4d` : c.ring,
    backgroundColor: unsuccessful ? c.dangerPressed : c.well,
  };
}

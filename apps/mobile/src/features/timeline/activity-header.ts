import { StyleSheet } from "react-native";
import type { Colors } from "../../ui/theme";

/** Matches the web activity header without changing its insets when status changes. */
export const activityHeader = StyleSheet.create({
  row: { borderLeftWidth: 2, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 8, minHeight: 44 },
});

export function activitySurface(c: Colors) {
  return {
    borderColor: c.ring,
    backgroundColor: c.well,
  };
}

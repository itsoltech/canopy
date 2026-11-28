import { StyleSheet } from "react-native";
import { createContext } from "react";
import type { Colors } from "../../ui/theme";

const edgeWidth = 2;
const groupTouchInset = 2;
const row = { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 8, minHeight: 44 };

/** Matches the web activity header without changing its insets when status changes. */
export const activityHeader = StyleSheet.create({
  shell: { borderLeftWidth: edgeWidth, borderRadius: 6, overflow: "hidden", minWidth: 0 },
  row,
  group: { paddingLeft: edgeWidth },
  groupSurface: { ...StyleSheet.absoluteFill, top: groupTouchInset, bottom: groupTouchInset },
  groupTarget: { paddingVertical: groupTouchInset },
  groupRow: { ...row, minHeight: row.minHeight - 2 * groupTouchInset },
  body: { paddingHorizontal: 8, paddingTop: 4, paddingBottom: 8, gap: 8, minWidth: 0 },
  open: { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
});

/** Stable group membership, without adding state to individual rows. */
export const ActivityGroup = createContext(false);

export function activitySurface(c: Colors) {
  return {
    borderColor: c.ring,
    backgroundColor: c.well,
  };
}

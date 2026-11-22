import { useState } from "react";
import { Pressable, Text } from "react-native";
import { Chevron } from "../../ui/MotionViews";
import { styles, useColors } from "../../ui/theme";
import type { useSidebarThreads } from "./useSidebarThreads";
import type { SidebarListEntry } from "./sidebar-drag";

export function useSnoozedThreads({ filtered, query }: ReturnType<typeof useSidebarThreads>) {
  const [open, setOpen] = useState(false);
  const searching = Boolean(query.trim());
  const expanded = open || searching;
  const count = filtered.snoozed.length;
  const entries: SidebarListEntry[] = count ? [{ key: "snoozed-heading", section: "snoozed" }] : [];

  if (expanded)
    for (const thread of filtered.snoozed) entries.push({ key: `snoozed-${thread.id}`, thread, section: "snoozed" });

  return { entries, count, expanded, searching, toggle: () => setOpen(!open) };
}

export function SidebarSnoozedHeader({ snoozed }: { snoozed: ReturnType<typeof useSnoozedThreads> }) {
  const c = useColors();
  const { count, expanded, searching, toggle } = snoozed;
  const formatted = new Intl.NumberFormat().format(count);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Snoozed, ${formatted} ${count === 1 ? "thread" : "threads"}`}
      accessibilityState={{ expanded, disabled: searching }}
      disabled={searching}
      onPress={toggle}
      style={[styles.row, { padding: 12, minHeight: 48, marginTop: 8 }]}
    >
      <Chevron open={expanded} size={14} />
      <Text style={[styles.meta, { color: c.muted, fontVariant: ["tabular-nums"] }]}>Snoozed · {formatted}</Text>
    </Pressable>
  );
}

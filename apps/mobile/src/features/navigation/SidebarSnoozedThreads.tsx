import { useState } from "react";
import { useDevicePreferences } from "../settings/device-preferences";
import type { useSidebarThreads } from "./useSidebarThreads";
import type { SidebarListEntry } from "./sidebar-drag";

export function useSnoozedThreads({ filtered, query }: ReturnType<typeof useSidebarThreads>) {
  const { view, setView } = useDevicePreferences();
  const [searchOpen, setSearchOpen] = useState(true);
  const searching = Boolean(query.trim());
  const expanded = searching ? searchOpen : view.snoozedThreadsExpanded;
  const count = filtered.snoozed.length;
  const entries: SidebarListEntry[] = count ? [{ key: "snoozed-heading", section: "snoozed-heading" }] : [];

  if (!searching && !searchOpen) setSearchOpen(true);

  if (expanded)
    for (const thread of filtered.snoozed) entries.push({ key: `snoozed-${thread.id}`, thread, section: "snoozed" });

  return {
    expanded,
    entries,
    count,
    searching,
    toggle() {
      if (searching) setSearchOpen((value) => !value);
      else setView({ snoozedThreadsExpanded: !expanded });
    },
  };
}

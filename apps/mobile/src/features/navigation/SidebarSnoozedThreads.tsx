import { useState } from "react";
import type { useSidebarThreads } from "./useSidebarThreads";
import type { SidebarListEntry } from "./sidebar-drag";
import { useSidebarDisclosureMotion } from "./SidebarThreadDisclosure";

export function useSnoozedThreads({ filtered, query }: ReturnType<typeof useSidebarThreads>) {
  const [open, setOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(true);
  const searching = Boolean(query.trim());
  const disclosure = useSidebarDisclosureMotion(searching ? searchOpen : open);
  const count = filtered.snoozed.length;
  const entries: SidebarListEntry[] = count ? [{ key: "snoozed-heading", section: "snoozed-heading" }] : [];

  if (!searching && !searchOpen) setSearchOpen(true);

  if (disclosure.rendered)
    for (const thread of filtered.snoozed) entries.push({ key: `snoozed-${thread.id}`, thread, section: "snoozed" });

  return {
    ...disclosure,
    entries,
    count,
    searching,
    toggle: () => (searching ? setSearchOpen((value) => !value) : setOpen((value) => !value)),
  };
}

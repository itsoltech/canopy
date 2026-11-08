import { createContext, useContext, useState, type ReactNode } from "react";
import { useWindowDimensions } from "react-native";
import { router, type Href } from "expo-router";

/**
 * From this window width (dp, Android's large-screen class) the thread list stays beside the open thread, as on
 * the desktop web: tablets, unfolded foldables, phones in landscape. Narrower windows keep the stack
 * (list → thread). The width is read live, so folding, rotating and resizing switch layouts without a restart.
 */
export const WIDE_LAYOUT = 600;

function useLayoutState() {
  const { width } = useWindowDimensions();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const wide = width >= WIDE_LAYOUT;

  return {
    wide,
    /** The sidebar takes about a third of the window, 260–320 dp. */
    sidebarWidth: Math.round(Math.min(320, Math.max(260, width * 0.36))),
    sidebarOpen: wide && sidebarOpen,
    /** The column animates itself (`MainNavigation`'s `SidebarColumn`). */
    toggleSidebar() {
      setSidebarOpen((open) => !open);
    },
    /** Opens a thread or chat: beside the list on wide windows (no history between them), pushed on phones. */
    open(href: Href) {
      if (wide) router.replace(href);
      else router.push(href);
    },
  };
}

const Context = createContext<ReturnType<typeof useLayoutState> | null>(null);

export function LayoutProvider({ children }: { children: ReactNode }) {
  return <Context.Provider value={useLayoutState()}>{children}</Context.Provider>;
}

export function useLayout() {
  const value = useContext(Context);

  if (!value) throw new Error("Missing LayoutProvider");

  return value;
}

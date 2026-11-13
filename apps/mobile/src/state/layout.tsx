import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useWindowDimensions } from "react-native";
import { router, usePathname, type Href } from "expo-router";
import { useSession } from "./session";
import { useDevicePreferences } from "../features/settings/device-preferences";
import { useOverview } from "./overview";
import { threadCacheCurrent } from "@canopy/domain/thread-warm-set";
import { mobileThreadTapped } from "../features/settings/client-diagnostics";

/**
 * From this window width (dp, Android's large-screen class) the thread list stays beside the open thread, as on
 * the desktop web: tablets, unfolded foldables, phones in landscape. Narrower windows keep the stack
 * (list → thread). The width is read live, so folding, rotating and resizing switch layouts without a restart.
 */
export const WIDE_LAYOUT = 600;

function useLayoutState() {
  const { width } = useWindowDimensions();
  const device = useDevicePreferences();
  const sidebarOpen = !device.view.sidebarCollapsed;
  const { threadCache } = useSession();
  const { warming } = useOverview();
  const opening = useRef(0);
  const pathname = usePathname();
  const wide = width >= WIDE_LAYOUT;

  useEffect(
    () => () => {
      opening.current++;
    },
    [threadCache, pathname],
  );

  function open(href: Href) {
    opening.current++;

    if (wide) router.replace(href);
    else router.push(href);
  }

  return {
    wide,
    /** The sidebar takes about a third of the window, 260–320 dp. */
    sidebarWidth: Math.round(Math.min(320, Math.max(260, width * 0.36))),
    sidebarOpen: wide && sidebarOpen,
    /** The column animates itself (`MainNavigation`'s `SidebarColumn`). */
    toggleSidebar() {
      device.setView({ sidebarCollapsed: sidebarOpen });
    },
    /** Opens a thread or chat: beside the list on wide windows (no history between them), pushed on phones. */
    open,
    /** Read local history before starting the push, so its first frame includes cached turns and their times. */
    async openThread(id: string) {
      const request = ++opening.current;
      warming?.yieldToNavigation();
      mobileThreadTapped(
        id,
        Boolean(threadCache?.peek(id)?.thread),
        Boolean(warming?.enabled && threadCacheCurrent(threadCache?.peek(id), warming.head(id))),
      );

      if (threadCache && !threadCache.peek(id)) await threadCache.load(id).catch(() => undefined);

      // A later tap or pairing change wins over an outstanding local read.
      if (request === opening.current) open({ pathname: "/thread/[id]", params: { id } });
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

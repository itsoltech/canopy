import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useWindowDimensions } from "react-native";
import { router, usePathname, type Href } from "expo-router";
import type { ModuleId } from "@canopy/domain";
import { useAppearance } from "./appearance";
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
  const moduleSelection = useModuleSelection(pathname);

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
    ...moduleSelection,
    sidebarOpen: wide && sidebarOpen,
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

function useModuleSelection(pathname: string) {
  const { modules } = useAppearance();
  const order = modules.join(",");
  const screen = pathname.split("/")[1] ?? "";

  const route: ModuleId | undefined = ["bot", "bot-exchange"].includes(screen)
    ? "bots"
    : ["thread", "thread-starting", "new-thread", "pull-request"].includes(screen)
      ? "threads"
      : undefined;

  const initial = route && modules.includes(route) ? route : modules[0];
  const [selection, setSelection] = useState({ order, route, value: initial });

  // Follow an opened conversation. Returning to the list keeps its tab until the configured order changes.
  if (selection.order !== order || selection.route !== route) {
    const value = route || selection.order !== order ? initial : selection.value;
    setSelection({ order, route, value });
  }

  return {
    selectedModule: selection.value,
    selectModule: (value: ModuleId) => setSelection({ order, route, value }),
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

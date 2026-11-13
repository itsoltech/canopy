import { createContext, useContext, useEffect, useState } from "react";
import { useSession } from "../../state/session";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";

interface PanelView {
  tab: string;
  scroll: Record<string, number>;
}

export const PullRequestView = createContext<PanelView | undefined>(undefined);

/** Presentation metadata shares the pairing's bounded cache; no hidden screen stays mounted. */
export function usePanelView(id: string) {
  const { queries } = useSession();
  const key = `PullRequestView:${id}`;
  const [view] = useState(() => queries.snapshot<PanelView>(key).data ?? { tab: "summary", scroll: {} });
  const [tab, select] = useState(view.tab);

  useEffect(() => {
    queries.set(key, view);
  }, [queries, key, view]);

  return {
    view,
    tab,
    select: (value: string) => {
      view.tab = value;
      select(value);
    },
  };
}

export function usePanelScroll(section: string, observe?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void) {
  const view = useContext(PullRequestView);
  const [initial] = useState(view?.scroll[section] ?? 0);

  return {
    contentOffset: { x: 0, y: initial },
    scrollEventThrottle: 32,
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      observe?.(event);

      if (view) view.scroll[section] = event.nativeEvent.contentOffset.y;
    },
  };
}

import { useCallback, useState } from "react";
import { useAnchoredToggle } from "../../ui/feed-anchor";
import { rememberVisualSession, visualSession } from "./visual-session";

/** Session consent belongs to the visual/version, independently of its current WebView slot. */
export function useVisualSession(id: string, version: number) {
  const anchor = useAnchoredToggle();
  const [state, setState] = useState(() => ({ id, version, ...visualSession(id, version) }));
  const current = state.id === id && state.version === version ? state : visualSession(id, version);

  function update(change: { run?: boolean; height?: number }) {
    rememberVisualSession(id, version, change);
    setState({ id, version, ...visualSession(id, version) });
  }

  const stop = useCallback(() => {
    rememberVisualSession(id, version, { run: false });
    setState({ id, version, ...visualSession(id, version) });
  }, [id, version]);

  return {
    run: current?.run ?? false,
    height: current?.height ?? 0,
    header: anchor.header,
    start: () => anchor.toggle(() => update({ run: true })),
    stop,
    measure: (height: number) => {
      if (height !== current?.height) update({ height });
    },
  };
}

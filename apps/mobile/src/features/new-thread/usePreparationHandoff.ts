import { useCallback, useEffect, useRef } from "react";
import { useAnimatedScrollHandler } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { ui } from "@canopy/contracts";
import type { useFollowingList } from "../../ui/useFollowingList";
import type { ScrollItem } from "../../ui/thread-scroll-items";

/** An inverted cell grows at its visual bottom. Keep its first input still while the initial reader waits. */
export function usePreparationHandoff(
  following: ReturnType<typeof useFollowingList<ui.Turn>>,
  items: ReadonlyMap<string, ScrollItem>,
  enabled: boolean,
) {
  const held = useRef<{ key: string; top: number } | undefined>(undefined);
  const frame = useRef(0);
  const attempts = useRef(0);
  const active = useRef(true);

  const cancel = useCallback(() => {
    held.current = undefined;
    cancelAnimationFrame(frame.current);
  }, []);

  useEffect(() => {
    active.current = true;

    return () => {
      active.current = false;
      cancelAnimationFrame(frame.current);
    };
  }, []);
  useEffect(() => {
    if (!enabled) cancel();
  }, [enabled, cancel]);

  const restore = useCallback(
    function restore() {
      const target = held.current;
      const item = target && items.get(target.key);

      if (!active.current || !enabled || !target || !item || following.isFollowing() || !following.reader.idle())
        return;
      following.list.current?.getNativeScrollRef()?.measureInWindow((_x: number, edge: number) => {
        item.node.measureInWindow((_x, top, _w, height) => {
          if (!active.current || held.current !== target || !height || !following.reader.idle()) return;
          const delta = top - edge - target.top;

          if (Math.abs(delta) < 1 || attempts.current++ >= 60) {
            attempts.current = 0;

            return;
          }

          following.restoreReading(following.scrollY.get() - delta);
          cancelAnimationFrame(frame.current);
          frame.current = requestAnimationFrame(restore);
        });
      });
    },
    [enabled, following, items],
  );

  const onScroll = useAnimatedScrollHandler({ onBeginDrag: () => scheduleOnRN(cancel) });

  return {
    hold: (key: string, top: number) => {
      held.current = { key, top };
    },
    restore,
    cancel,
    onScroll,
  };
}

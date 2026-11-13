import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppState, type FlatListProps } from "react-native";
import { useFocusEffect } from "expo-router";
import {
  useAnimatedScrollHandler,
  useComposedEventHandler,
  type ScrollHandlerProcessed,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { ui } from "@canopy/contracts";
import { restoreThreadAnchor, threadAnchorOffset, type ThreadScrollPosition } from "@canopy/domain/thread-scroll";
import { useDevicePreferences } from "../settings/device-preferences";
import type { useFollowingList } from "../../ui/useFollowingList";
import type { ScrollItem } from "../../ui/thread-scroll-items";

export const scrollTurnKey = (turn: ui.Turn) => `${turn.fromThreadId}:${turn.id}`;

function useBackgroundCapture(capture: () => void) {
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") capture();
    });

    return () => subscription.remove();
  }, [capture]);
}

/** Restore only the already loaded window. Native list measurement retries are bounded, never history reads. */
export function useThreadScrollMemory(
  id: string,
  turns: readonly ui.Turn[],
  loaded: boolean,
  following: ReturnType<typeof useFollowingList<ui.Turn>>,
  onScroll: ScrollHandlerProcessed,
  readHistory: () => void,
) {
  const preferences = useDevicePreferences();
  const latest = useRef({ preferences, turns, loaded, following, readHistory });
  useLayoutEffect(() => {
    latest.current = { preferences, turns, loaded, following, readHistory };
  });
  const [items] = useState(() => new Map<string, ScrollItem>());
  const [initial] = useState(() => preferences.view.threadScroll.find((entry) => entry.threadId === id)?.position);
  const [positioned, setPositioned] = useState(false);
  const done = useRef(false);
  const retries = useRef(0);
  const frame = useRef(0);
  const active = useRef(true);
  const captureVersion = useRef(0);

  const save = useCallback(
    (position: ThreadScrollPosition) => {
      const { preferences } = latest.current;
      preferences.saveThreadScroll(id, position);
    },
    [id],
  );

  const capture = useCallback(() => {
    if (!done.current || !active.current) return;
    const version = ++captureVersion.current;
    const { following } = latest.current;

    if (following.isFollowing()) return save({ mode: "following" });
    following.list.current
      ?.getNativeScrollRef()
      ?.measureInWindow((_x: number, edge: number, _w: number, height: number) => {
        const candidates: { key: string; parent: string; top: number; height: number }[] = [];
        let pending = items.size;

        for (const [key, item] of items)
          item.node.measureInWindow((_x, top, _w, itemHeight) => {
            if (itemHeight > 0 && top + itemHeight > edge + 1 && top < edge + height)
              candidates.push({ key, parent: item.parent, top, height: itemHeight });

            if (--pending !== 0 || !candidates.length || captureVersion.current !== version) return;
            const first = candidates.sort((a, b) => a.top - b.top)[0];

            if (first) save({ mode: "anchor", key: first.key, parent: first.parent, offset: edge - first.top });
          });
      });
  }, [items, save]);

  const finish = useCallback((followingEnd: boolean) => {
    if (!active.current) return;
    const { following } = latest.current;

    if (followingEnd) following.resumeFollowing();
    else {
      following.restoreReading();
      latest.current.readHistory();
    }

    done.current = true;
    setPositioned(true);
  }, []);

  const restore = useCallback(
    function restore() {
      if (done.current || !active.current || !latest.current.loaded) return;
      const { following, turns } = latest.current;

      if (initial?.mode !== "anchor") return finish(true);
      const target = restoreThreadAnchor(initial, turns.map(scrollTurnKey));

      if (!target || retries.current++ >= 60) return finish(true);
      const item = items.get(initial.key);

      if (!item) {
        following.list.current?.scrollToIndex({ index: target.index, animated: false, viewPosition: 1 });
      } else
        following.list.current?.getNativeScrollRef()?.measureInWindow((_x: number, edge: number) => {
          item.node.measureInWindow((_x, top, _w, height) => {
            if (!active.current || done.current || height <= 0) return;
            const delta = top - edge + threadAnchorOffset(initial.offset, height);
            following.restoreReading(following.scrollY.get() - delta);

            if (Math.abs(delta) < 1) finish(false);
          });
        });
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(restore);
    },
    [initial, items, finish],
  );

  useFocusEffect(
    useCallback(() => {
      active.current = true;

      return () => {
        capture();
        active.current = false;
        cancelAnimationFrame(frame.current);
      };
    }, [capture]),
  );
  useBackgroundCapture(capture);

  const memoryScroll = useAnimatedScrollHandler({
    onEndDrag: () => scheduleOnRN(capture),
    onMomentumEnd: () => scheduleOnRN(capture),
  });

  const composed = useComposedEventHandler([onScroll, memoryScroll]);

  const onViewableItemsChanged = useCallback<NonNullable<FlatListProps<ui.Turn>["onViewableItemsChanged"]>>(() => {
    if (done.current) capture();
  }, [capture]);

  const onScrollToIndexFailed: FlatListProps<ui.Turn>["onScrollToIndexFailed"] = (info) => {
    if (done.current) return;
    following.list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
  };

  return {
    items,
    target: initial?.mode === "anchor" ? initial.key : undefined,
    positioned,
    restore,
    onScroll: composed,
    onScrollToIndexFailed,
    onViewableItemsChanged,
  };
}

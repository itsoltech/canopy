import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
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
import type { ThreadCreation } from "../new-thread/thread-creations";
import { usePreparationHandoff } from "../new-thread/usePreparationHandoff";

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
  preparation?: ThreadCreation,
) {
  const preferences = useDevicePreferences();
  const latest = useRef({ preferences, turns, loaded, following, readHistory, preparation });
  useLayoutEffect(() => {
    latest.current = { preferences, turns, loaded, following, readHistory, preparation };
  });
  const [items] = useState(() => new Map<string, ScrollItem>());
  const handoff = usePreparationHandoff(following, items, turns.length === 1 && turns[0]?.ordinal === 1);
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

  const finish = useCallback((followingEnd: boolean, keepComposer = false) => {
    if (!active.current) return;
    const { following } = latest.current;

    if (followingEnd) following.resumeFollowing();
    else {
      following.restoreReading();

      if (!keepComposer) latest.current.readHistory();
    }

    if (latest.current.preparation) latest.current.preparation.preparationAnchor = undefined;
    done.current = true;
    setPositioned(true);
  }, []);

  const restore = useCallback(
    function restore() {
      if (!active.current || !latest.current.loaded) return;

      if (done.current) return handoff.restore();

      const { following, turns } = latest.current;

      const preparation = latest.current.preparation?.preparationAnchor;
      const position = restorationPosition(initial, preparation, turns);

      if (!position) return finish(true);

      if (preparation) handoff.hold(position.key, preparation.top);
      const target = restoreThreadAnchor(position, turns.map(scrollTurnKey));

      if (!target || retries.current++ >= 60) return finish(true);
      const item = items.get(position.key);

      if (!item) {
        // Restoring a reading position: the feed must not pull it back to the end meanwhile.
        following.restoreReading();
        following.list.current?.scrollToIndex({ index: target.index, animated: false, viewPosition: 1 });
      } else
        following.list.current?.getNativeScrollRef()?.measureInWindow((_x: number, edge: number) => {
          item.node.measureInWindow((_x, top, _w, height) => {
            if (!active.current || done.current || height <= 0) return;

            const delta =
              top - edge + threadAnchorOffset(position.offset, height, preparation ? Math.max(0, preparation.top) : 0);

            if (Math.abs(delta) < 1)
              finish(Boolean(preparation && following.distance(following.scrollY.get()) < 0.5), Boolean(preparation));
            else following.restoreReading(following.scrollY.get() - delta);
          });
        });
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(restore);
    },
    [initial, items, finish, handoff],
  );

  // A short thread fills the viewport-high content container both before and after it loads, so no layout or
  // content size event reports its arrival (a new thread's first message).
  useEffect(() => {
    if (loaded) restore();
  }, [loaded, restore]);

  useScrollLifecycle(capture, active, frame);

  const memoryScroll = useAnimatedScrollHandler({
    onEndDrag: () => scheduleOnRN(capture),
    onMomentumEnd: () => scheduleOnRN(capture),
  });

  const composed = useComposedEventHandler([onScroll, memoryScroll, handoff.onScroll]);

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
    onTouchStart: handoff.cancel,
    onScrollToIndexFailed,
    onViewableItemsChanged,
  };
}

function restorationPosition(
  saved: ThreadScrollPosition | undefined,
  preparation: ThreadCreation["preparationAnchor"],
  turns: readonly ui.Turn[],
): Extract<ThreadScrollPosition, { mode: "anchor" }> | undefined {
  if (saved?.mode === "anchor") return saved;
  const first = turns.find((turn) => turn.ordinal === 1);

  return preparation && first
    ? {
        mode: "anchor",
        key: `${scrollTurnKey(first)}/input`,
        parent: scrollTurnKey(first),
        offset: -preparation.top,
      }
    : undefined;
}

function useScrollLifecycle(capture: () => void, active: RefObject<boolean>, frame: RefObject<number>) {
  useFocusEffect(
    useCallback(() => {
      active.current = true;

      return () => {
        capture();
        active.current = false;
        cancelAnimationFrame(frame.current);
      };
    }, [capture, active, frame]),
  );
  useBackgroundCapture(capture);
}

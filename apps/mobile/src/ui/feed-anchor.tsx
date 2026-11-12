import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { View } from "react-native";
import {
  measure,
  scrollTo,
  useAnimatedRef,
  useFrameCallback,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN, scheduleOnUI } from "react-native-worklets";
import type { ui } from "@canopy/contracts";
import type { useFollowingList } from "./useFollowingList";
import { motion, useReducedMotion } from "./motion";

/** Native cell anchoring yields to the tapped header for one disclosure transition. */
class AnchorSession {
  #version = 0;
  #manual = false;
  #listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  manual = () => this.#manual;

  begin() {
    this.#version++;
    this.#manual = true;
    this.#emit();

    return this.#version;
  }

  end(version: number) {
    if (!this.#manual || version !== this.#version) return;
    this.#manual = false;
    this.#emit();
  }

  #emit() {
    for (const listener of this.#listeners) listener();
  }
}

export function useFeedAnchor({
  list,
  scrollY,
  minimum,
  corrections,
  anchoring,
  track,
}: ReturnType<typeof useFollowingList<ui.Turn>>) {
  const generation = useSharedValue(0);
  const [session] = useState(() => new AnchorSession());

  const geometry = useMemo(
    () => ({ list, scrollY, minimum, corrections, anchoring, generation, track }),
    [list, scrollY, minimum, corrections, anchoring, generation, track],
  );

  return useMemo(() => ({ session, geometry }), [session, geometry]);
}

const Anchor = createContext<ReturnType<typeof useFeedAnchor> | null>(null);
const idle = new AnchorSession();

/** Inverted: increasing the offset moves the header down, against growth above the cell's bottom. */
function correctHeader(
  geometry: ReturnType<typeof useFeedAnchor>["geometry"],
  top: SharedValue<number>,
  after: number,
) {
  "worklet";
  const delta = after - top.get();

  if (Math.abs(delta) < 0.5) return true;
  const next = Math.max(geometry.minimum.get(), geometry.scrollY.get() - delta);

  // At the physical end there may be no scroll range left to preserve the old position.
  if (Math.abs(next - geometry.scrollY.get()) < 0.5) top.set(after);
  geometry.scrollY.set(next);
  geometry.corrections.set(geometry.corrections.get() + 1);
  scrollTo(geometry.list, 0, next, false);

  return false;
}

export function FeedAnchorProvider({
  value,
  children,
}: {
  value: ReturnType<typeof useFeedAnchor>;
  children: ReactNode;
}) {
  return <Anchor.Provider value={value}>{children}</Anchor.Provider>;
}

/** Only the list wrapper subscribes; starting a toggle does not replace turn props or the data array. */
export function useManualFeedAnchor() {
  const session = useContext(Anchor)?.session ?? idle;

  return useSyncExternalStore(session.subscribe, session.manual);
}

/**
 * Synchronous UI geometry replaces delayed JS measurements of possibly clipped cells. Only the tapped
 * header's frame callback runs. A drag cancels the correction; a newer tap supersedes the older session.
 */
export function useAnchoredToggle() {
  const anchor = useContext(Anchor);
  const header = useAnimatedRef<View>();
  const reduced = useReducedMotion();
  const top = useSharedValue(0);
  const started = useSharedValue(0);
  const version = useSharedValue(0);
  const stable = useSharedValue(0);
  const active = useSharedValue(false);
  // Keep class instances and JS listeners out of the worklet closure.
  const geometry = anchor?.geometry;

  const finish = (id: number) => {
    if (version.get() === id) frames.setActive(false);
    anchor?.session.end(id);

    if (!geometry) return;
    scheduleOnUI(() => {
      if (geometry.generation.get() !== id) return;
      geometry.anchoring.set(false);
      geometry.track(geometry.scrollY.get());
    });
  };

  const frames = useFrameCallback(() => {
    "worklet";

    if (!geometry || !active.get()) return;
    const box = measure(header);

    if (!geometry.anchoring.get() || geometry.generation.get() !== version.get() || !box || box.height <= 0) {
      active.set(false);
      scheduleOnRN(finish, version.get());

      return;
    }

    stable.set(correctHeader(geometry, top, box.pageY) ? stable.get() + 1 : 0);

    const elapsed = Date.now() - started.get();

    if ((elapsed >= (reduced ? 0 : motion.fast) && stable.get() >= 2) || elapsed >= motion.fast + motion.slow) {
      active.set(false);
      geometry.anchoring.set(false);
      scheduleOnRN(finish, version.get());
    }
  }, false);

  useEffect(
    () => () => {
      frames.setActive(false);
      anchor?.session.end(version.get());

      if (!geometry) return;
      scheduleOnUI(() => {
        if (geometry.generation.get() === version.get()) geometry.anchoring.set(false);
      });
    },
    [frames, anchor, version, geometry],
  );

  return {
    header,
    toggle(change: () => void) {
      if (!anchor || !geometry) return change();
      const id = anchor.session.begin();
      frames.setActive(true);
      scheduleOnUI(() => {
        const box = measure(header);
        version.set(id);
        geometry.generation.set(id);
        stable.set(0);
        started.set(Date.now());
        active.set(Boolean(box && box.height > 0));
        geometry.anchoring.set(active.get());

        if (box) top.set(box.pageY);
        scheduleOnRN(change);

        if (!active.get()) scheduleOnRN(finish, id);
      });
    },
  };
}

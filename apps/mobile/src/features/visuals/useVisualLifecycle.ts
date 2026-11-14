import { useEffect, useMemo, useRef, useState } from "react";
import type { ui, Visual } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useTimelineDirectory } from "../timeline/directory";
import { loadVisual } from "./visual-source";
import { claimVisualSlot, releaseVisualSlot, waitForVisualSlot, type VisualSlot } from "./visual-slots";

const LINGER_MS = 5000;

/**
 * When a visual may hold the one WebView slot and which version it has loaded. It claims the slot while on screen
 * (or in full screen) and the slot is free; off screen it releases it after 5 s, in the background at once. The
 * spec is read only while the slot is held.
 */
export function useVisualLifecycle({
  visual,
  version,
  showing,
  appActive,
  fullscreen,
}: {
  visual: Visual;
  version: number;
  showing: boolean;
  appActive: boolean;
  fullscreen: boolean;
}) {
  const { client } = useSession();
  const directory = useTimelineDirectory();
  const [live, setLive] = useState(false);
  const [response, setResponse] = useState<ui.GetVisualResponse>();
  const [failure, setFailure] = useState("");
  const [attempt, setAttempt] = useState(0);
  const pinned = useRef(false);

  const slot = useMemo<VisualSlot>(() => ({ pinned: () => pinned.current, evict: () => setLive(false) }), []);

  useEffect(() => {
    pinned.current = fullscreen;
  }, [fullscreen]);

  useEffect(() => {
    if (showing || fullscreen) {
      setLive((current) => current || claimVisualSlot(slot, false));

      return;
    }

    const stop = () => {
      setLive(false);
      setResponse(undefined);
      releaseVisualSlot(slot);
    };

    if (!appActive) return stop();
    const linger = setTimeout(stop, LINGER_MS);

    return () => clearTimeout(linger);
  }, [showing, appActive, fullscreen, slot]);

  useEffect(() => {
    if (live || !showing) return;

    return waitForVisualSlot(() => setLive(claimVisualSlot(slot, false)));
  }, [live, showing, slot]);

  useEffect(() => () => releaseVisualSlot(slot), [slot]);

  useEffect(() => {
    if (!live || !client) return;
    let cancelled = false;

    loadVisual(client.api, directory.currentId, visual.visualId, version).then(
      (loaded) => {
        if (!cancelled) setResponse(loaded);
      },
      () => {
        if (!cancelled) setFailure("Couldn't open this visual.");
      },
    );

    return () => {
      cancelled = true;
    };
  }, [live, client, directory.currentId, visual.visualId, version, attempt]);

  return {
    live,
    response,
    failure,
    attempt,
    /** The loaded version on screen, once nothing failed. */
    ready: live && response?.visual?.version === version && !failure ? response : undefined,
    /** An explicit request: takes the slot from a visual that isn't in full screen. */
    open() {
      const claimed = claimVisualSlot(slot, true);
      setLive(claimed);
      setFailure(claimed ? "" : "Close another visual to open this one.");
      setAttempt((n) => n + 1);
    },
    claim: () => setLive(claimVisualSlot(slot, true)),
    retry: () => setAttempt((n) => n + 1),
  };
}

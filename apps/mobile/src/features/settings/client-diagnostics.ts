import * as Crypto from "expo-crypto";
import { useEffect, useEffectEvent } from "react";
import { AppState } from "react-native";
import { ClientMeasurements } from "@canopy/domain/diagnostics";
import type { Client } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import { diagnosticsEpochs } from "./diagnostics-epochs";
import { whileForeground } from "../../state/foreground-work";

export const mobileMeasurements = new ClientMeasurements("mobile", Crypto.randomUUID());

let opening:
  | {
      start: number;
      id: string;
      frame: number;
      snapshot: boolean;
      cached: boolean;
      painting: boolean;
      layout: boolean;
      current: boolean;
      currentPaint: boolean;
      painted: boolean;
    }
  | undefined;

let tapped = "";

export function mobileThreadTapped(id: string, cached: boolean, current: boolean) {
  beginMobileOpening(id, cached);
  tapped = id;
  mobileMeasurements.record(13, current ? 100 : 0);

  if (opening) opening.current = current;
}

export function useMobileOpening(id: string, cached: boolean, current = false) {
  const begin = useEffectEvent(() => {
    if (tapped !== id) {
      beginMobileOpening(id, cached);
      mobileMeasurements.record(13, current ? 100 : 0);
    }

    tapped = "";

    if (current) mobileCurrentVisible(id);
  });

  useEffect(() => {
    begin();
    const current = opening;

    return () => {
      if (opening === current) cancelMobileOpening();
    };
  }, [id]);
}

export function mobileCacheLoaded() {
  if (opening) opening.cached = true;
}

export function startMobileDiagnostics(api: Client<typeof ui.GatewayService>) {
  diagnosticsEpochs.clear();
  let busy = false;

  const stop = whileForeground(AppState, () => {
    const abort = new AbortController();

    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void api
        .submitDiagnostics(mobileMeasurements.take(), { signal: abort.signal, timeoutMs: 5000 })
        .then((receipt) => {
          if (!abort.signal.aborted && !receipt.accepted) mobileMeasurements.clear(receipt.epoch);
        })
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    }, 60_000);

    return () => {
      clearInterval(timer);
      abort.abort();
      cancelMobileOpening();
      mobileMeasurements.clear(mobileMeasurements.epoch);
    };
  });

  return () => {
    stop();
    cancelMobileOpening();
    mobileMeasurements.clear();
  };
}

export function beginMobileOpening(id: string, cached = false) {
  cancelMobileOpening();

  if (!mobileMeasurements.opening()) return;

  const current = {
    start: performance.now(),
    id,
    frame: 0,
    snapshot: false,
    cached,
    painting: false,
    layout: false,
    current: false,
    currentPaint: false,
    painted: false,
  };

  let previous = current.start;

  const frame = () => {
    if (opening !== current) return;
    const now = performance.now();

    if (AppState.currentState !== "active" || now - current.start > 30_000) {
      cancelMobileOpening();

      return;
    }

    if (now - previous > 50) mobileMeasurements.record(5, now - previous);
    previous = now;
    current.frame = requestAnimationFrame(frame);
  };

  opening = current;
  current.frame = requestAnimationFrame(frame);
}

export function mobileSnapshotStarted(id: string) {
  return opening?.id === id && !opening.snapshot ? performance.now() : 0;
}

export function mobileSnapshotFinished(start: number) {
  if (!start || !opening || opening.snapshot) return;
  opening.snapshot = true;
  mobileMeasurements.record(2, performance.now() - start);
}

export function mobileFeedLayout(id: string) {
  const current = opening;

  if (!current || current.id !== id) return;
  current.layout = true;

  if (current.current) mobileCurrentVisible(id);

  if (current.painting) return;

  if (performance.now() - current.start > 30_000) {
    cancelMobileOpening();

    return;
  }

  current.painting = true;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (opening === current && AppState.currentState === "active") {
        mobileMeasurements.record(current.cached ? 0 : 1, performance.now() - current.start);
        current.painted = true;

        if (current.currentPaint) cancelMobileOpening();
      }
    }),
  );
}

/** A layout plus a current sequence checkpoint; the next rAF is a JS presentation proxy. */
export function mobileCurrentVisible(id: string) {
  const current = opening;

  if (!current || current.id !== id) return;
  current.current = true;

  if (!current.layout || current.currentPaint) return;
  current.currentPaint = true;
  requestAnimationFrame(() => {
    if (opening !== current || AppState.currentState !== "active") return;
    mobileMeasurements.record(12, performance.now() - current.start);

    if (current.painted) cancelMobileOpening();
  });
}

export function cancelMobileOpening() {
  if (opening) cancelAnimationFrame(opening.frame);
  opening = undefined;
  tapped = "";
}

import * as Crypto from "expo-crypto";
import { useEffect, useEffectEvent } from "react";
import { AppState } from "react-native";
import { ClientMeasurements } from "@canopy/domain/diagnostics";
import type { Client } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import { diagnosticsEpochs } from "./diagnostics-epochs";

export const mobileMeasurements = new ClientMeasurements("mobile", Crypto.randomUUID());
let opening: { start: number; frame: number; snapshot: boolean; cached: boolean; painting: boolean } | undefined;

export function useMobileOpening(id: string, cached: boolean) {
  const begin = useEffectEvent(() => beginMobileOpening(cached));

  useEffect(() => {
    begin();

    return cancelMobileOpening;
  }, [id]);
}

export function mobileCacheLoaded() {
  if (opening) opening.cached = true;
}

export function startMobileDiagnostics(api: Client<typeof ui.GatewayService>) {
  diagnosticsEpochs.clear();
  let busy = false;
  const abort = new AbortController();

  const activity = AppState.addEventListener("change", (state) => {
    if (state !== "active") {
      cancelMobileOpening();
      mobileMeasurements.clear(mobileMeasurements.epoch);
    }
  });

  const timer = setInterval(() => {
    if (busy || AppState.currentState !== "active") return;
    busy = true;
    void api
      .submitDiagnostics(mobileMeasurements.take(), { signal: abort.signal, timeoutMs: 5000 })
      .then((receipt) => {
        if (!receipt.accepted) mobileMeasurements.clear(receipt.epoch);
      })
      .catch(() => {})
      .finally(() => {
        busy = false;
      });
  }, 60_000);

  return () => {
    clearInterval(timer);
    activity.remove();
    abort.abort();
    cancelMobileOpening();
    mobileMeasurements.clear();
  };
}

export function beginMobileOpening(cached = false) {
  cancelMobileOpening();

  if (!mobileMeasurements.opening()) return;
  const current = { start: performance.now(), frame: 0, snapshot: false, cached, painting: false };
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

export function mobileSnapshotStarted() {
  return opening && !opening.snapshot ? performance.now() : 0;
}

export function mobileSnapshotFinished(start: number) {
  if (!start || !opening || opening.snapshot) return;
  opening.snapshot = true;
  mobileMeasurements.record(2, performance.now() - start);
}

export function mobileFeedLayout() {
  const current = opening;

  if (!current || current.painting) return;

  if (performance.now() - current.start > 30_000) {
    cancelMobileOpening();

    return;
  }

  current.painting = true;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (opening === current && AppState.currentState === "active") {
        mobileMeasurements.record(current.cached ? 0 : 1, performance.now() - current.start);
        cancelMobileOpening();
      }
    }),
  );
}

export function cancelMobileOpening() {
  if (opening) cancelAnimationFrame(opening.frame);
  opening = undefined;
}

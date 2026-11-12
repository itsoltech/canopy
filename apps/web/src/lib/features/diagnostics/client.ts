import { toJson } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { ClientMeasurements } from "@canopy/domain/diagnostics";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";

export let clientMeasurements = new ClientMeasurements("web", crypto.randomUUID());
let observed = false;
let navigationAt = 0;

export function navigationStarted() {
  navigationAt = performance.now();
}

/** Installed once while the app is mounted. Only sampled openings enable the per-open observers. */
export function startClientDiagnostics() {
  if (window.canopyDesktop) clientMeasurements = new ClientMeasurements("desktop", crypto.randomUUID());
  let pending = false;
  let paint: PerformanceObserver | undefined;

  const pause = () => {
    if (document.hidden) clientMeasurements.clear(clientMeasurements.epoch);
  };

  document.addEventListener("visibilitychange", pause);

  const timer = setInterval(() => {
    if (document.hidden || !navigator.onLine || pending) return;
    pending = true;
    void requestJson(
      "POST",
      "/api/diagnostics/submit",
      toJson(ui.SubmitDiagnosticsRequestSchema, clientMeasurements.take()),
      5000,
    )
      .then((value) => {
        const receipt = decode(ui.DiagnosticsReceiptSchema, value);

        if (!receipt.accepted) clientMeasurements.clear(receipt.epoch);
      })
      .catch(() => {})
      .finally(() => {
        pending = false;
      });
  }, 60_000);

  if (!observed) {
    observed = true;

    if (clientMeasurements.opening() && globalThis.PerformanceObserver?.supportedEntryTypes?.includes("paint")) {
      paint = new PerformanceObserver((list) => {
        const fcp = list.getEntries().find((entry) => entry.name === "first-contentful-paint");

        if (!fcp) return;

        if (!document.hidden) clientMeasurements.record(3, fcp.startTime);
        paint?.disconnect();
      });
      paint.observe({ type: "paint", buffered: true });
    }
  }

  return () => {
    clearInterval(timer);
    paint?.disconnect();
    document.removeEventListener("visibilitychange", pause);
    clientMeasurements.clear();
  };
}

export function clientOpening(cached: boolean) {
  const started = navigationAt || performance.now();
  navigationAt = 0;

  if (!clientMeasurements.opening()) return;
  let finished = false;
  let observer: PerformanceObserver | undefined;

  if (globalThis.PerformanceObserver?.supportedEntryTypes?.includes("longtask")) {
    observer = new PerformanceObserver((list) => {
      if (!document.hidden) for (const entry of list.getEntries()) clientMeasurements.record(4, entry.duration);
    });
    observer.observe({ type: "longtask" });
  }

  const deadline = setTimeout(() => {
    observer?.disconnect();
    finished = true;
  }, 30_000);

  return {
    snapshot(started: number) {
      if (!finished) clientMeasurements.record(2, performance.now() - started);
    },
    paint() {
      if (finished) return;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!finished && !document.hidden) clientMeasurements.record(cached ? 0 : 1, performance.now() - started);
          finished = true;
          clearTimeout(deadline);
          observer?.disconnect();
        }),
      );
    },
    cancel() {
      finished = true;
      clearTimeout(deadline);
      observer?.disconnect();
    },
  };
}

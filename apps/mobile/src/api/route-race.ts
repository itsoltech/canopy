import type { PinnedTransport } from "./routes";
import { RouteDiagnostics, routeFailure } from "./route-diagnostics";
import { FAST_PROBE_MS, RECOVERY_PROBE_MS, ProbeError, probeRoute } from "./route-probe";

export const FAILED_FOR = 10_000;
const STAGGER = 250;

/** One bounded race for all callers: give timed-out handshakes one longer window to wake a VPN/radio. */
export function raceRoutes(options: {
  candidates: string[];
  fingerprint: string;
  transport: PinnedTransport;
  diagnostics: RouteDiagnostics;
  failed: Map<string, number>;
  signal: AbortSignal;
}) {
  const { candidates, diagnostics, failed, signal } = options;
  const controller = new AbortController();
  const codes = new Set<string>();
  diagnostics.update({ pending: true, active: undefined });

  return new Promise<string>((resolve, reject) => {
    let next = 0;
    let running = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (address?: string) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      controller.abort();
      diagnostics.update({
        pending: false,
        routes: diagnostics
          .snapshot()
          .routes.map((route) => (route.outcome === "probing" ? { ...route, outcome: "canceled" } : route)),
      });

      if (address) resolve(address);
      else
        reject(
          new Error(
            `Cannot reach this computer securely. Check the connection, then reconnect.${codes.size ? ` (${[...codes].join(", ")})` : ""}`,
          ),
        );
    };

    const abort = () => finish();

    const launch = () => {
      clearTimeout(timer);

      if (controller.signal.aborted || next >= candidates.length) return;
      const address = candidates[next++]!;
      const started = Date.now();
      running++;
      diagnostics.result(address, "probing", started);
      timer = setTimeout(launch, STAGGER);
      adaptiveProbe(options, address, controller.signal).then(
        () => {
          if (controller.signal.aborted) return;
          failed.delete(address);
          diagnostics.result(address, "ok", started);
          finish(address);
        },
        (error: Error) => {
          if (controller.signal.aborted) return;
          running--;
          failed.set(address, Date.now() + FAILED_FOR);

          if (error instanceof ProbeError) codes.add(error.code);
          diagnostics.result(address, routeFailure(error instanceof ProbeError ? error.code : ""), started);

          if (next < candidates.length) launch();
          else if (!running) finish();
        },
      );
    };

    signal.addEventListener("abort", abort, { once: true });

    if (signal.aborted) abort();
    else launch();
  });
}

async function adaptiveProbe(
  options: { transport: PinnedTransport; fingerprint: string },
  address: string,
  signal: AbortSignal,
) {
  try {
    await probeRoute(options.transport, address, options.fingerprint, signal, FAST_PROBE_MS);
  } catch (error) {
    // DNS, refusal and a changed certificate do not improve with a longer handshake. Never retry an RPC here.
    if (signal.aborted || !(error instanceof ProbeError) || routeFailure(error.code) !== "timeout") throw error;
    await probeRoute(options.transport, address, options.fingerprint, signal, RECOVERY_PROBE_MS);
  }
}

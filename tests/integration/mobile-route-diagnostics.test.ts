import { describe, expect, test } from "bun:test";
import { RouteDiagnostics, routeOutcome, connectionReport } from "../../apps/mobile/src/api/route-diagnostics";
import { raceRoutes } from "../../apps/mobile/src/api/route-race";
import { ProbeError, type PinnedTransport } from "../../apps/mobile/src/api/routes";

const addresses = ["https://192.0.2.10:24443", "https://192.0.2.11:24443"];

describe("mobile diagnostics during recovery", () => {
  test("retries preserve each last result and timestamp; cancellation clears activity without losing evidence", async () => {
    const diagnostics = new RouteDiagnostics(addresses);
    const previous = diagnostics.result(addresses[0]!, "refused", Date.now() - 50);
    diagnostics.result(addresses[1]!, "failed", Date.now() - 25);
    const controller = new AbortController();

    const transport: PinnedTransport = {
      probe: () => new Promise(() => {}),
      fetch: () => {
        throw new Error("No RPC during a probe");
      },
      reset() {},
    };

    const racing = raceRoutes({
      candidates: addresses,
      fingerprint: "a".repeat(64),
      transport,
      diagnostics,
      failed: new Map(),
      signal: controller.signal,
    });

    const during = diagnostics.snapshot();
    expect(during.pending).toBe(true);
    expect(during.routes[0]).toEqual({ ...previous, checking: true });
    expect(routeOutcome(during.routes[0]!)).toBe("Connection refused");
    expect(routeOutcome(during.routes[1]!)).toBe("Connection failed");
    controller.abort();
    await expect(racing).rejects.toThrow("Cannot reach");
    diagnostics.reset(addresses);
    expect(diagnostics.snapshot().routes[0]).toEqual({ ...previous, checking: false });
    expect(connectionReport(diagnostics.snapshot())).toContain("Connection refused");
    expect(diagnostics.snapshot().routes.every((route) => !route.checking)).toBe(true);
  });

  test("the next completed race replaces old results and retains them while another starts", async () => {
    const diagnostics = new RouteDiagnostics(addresses);
    diagnostics.result(addresses[0]!, "timeout", Date.now() - 2000);

    const transport: PinnedTransport = {
      async probe() {
        throw new ProbeError("ECONNREFUSED");
      },
      fetch: () => {
        throw new Error("No RPC during a probe");
      },
      reset() {},
    };

    await expect(
      raceRoutes({
        candidates: addresses,
        fingerprint: "a".repeat(64),
        transport,
        diagnostics,
        failed: new Map(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Cannot reach");
    expect(diagnostics.snapshot().lastRace?.map((route) => route.outcome)).toEqual(["refused", "refused"]);
    expect(diagnostics.snapshot().routes.every((route) => route.outcome === "refused" && !route.checking)).toBe(true);
  });
});

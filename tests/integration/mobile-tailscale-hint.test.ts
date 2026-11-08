import { describe, expect, test } from "bun:test";
import { hasTailscaleFailure } from "../../apps/mobile/src/api/tailscale-hint";
import type { RouteOutcome, RouteResult, RouteSnapshot } from "../../apps/mobile/src/api/route-diagnostics";

const off: RouteResult[] = [
  { address: "https://<host>.ts.net", kind: "Tailscale", outcome: "dns", phase: "probe" },
  { address: "https://100.x.y.z", kind: "Tailscale", outcome: "timeout", phase: "probe" },
  { address: "https://192.168.x.y", kind: "LAN", outcome: "timeout", phase: "probe" },
];

const snapshot = (lastRace: readonly RouteResult[]): RouteSnapshot => ({ routes: [], lastRace, pending: false });

describe("guidance from the latest completed route race", () => {
  test("DNS failure plus timeouts suggests checking Tailscale on the phone", () => {
    expect(hasTailscaleFailure(snapshot(off))).toBe(true);
  });

  test("all timeouts also suggest checking a stuck tunnel", () => {
    const stuck = off.map((route) => ({ ...route, outcome: "timeout" as const }));
    expect(hasTailscaleFailure(snapshot(stuck))).toBe(true);
  });

  test.each<RouteOutcome>(["pin", "refused", "failed", "unchecked", "probing", "canceled", "ok"])(
    "a Tailscale route with outcome %s prevents the hint",
    (outcome) => {
      expect(
        hasTailscaleFailure(snapshot(off.map((route, index) => (index === 0 ? { ...route, outcome } : route)))),
      ).toBe(false);
    },
  );

  test("a pairing without Tailscale routes has no hint", () => {
    expect(hasTailscaleFailure(snapshot(off.filter((route) => route.kind === "LAN")))).toBe(false);
  });

  test("a successful LAN route prevents the hint", () => {
    expect(
      hasTailscaleFailure(snapshot(off.map((route) => (route.kind === "LAN" ? { ...route, outcome: "ok" } : route)))),
    ).toBe(false);
  });

  test("uncompleted or canceled LAN checks do not count as failures", () => {
    for (const outcome of ["unchecked", "probing", "canceled"] as const) {
      expect(
        hasTailscaleFailure(snapshot(off.map((route) => (route.kind === "LAN" ? { ...route, outcome } : route)))),
      ).toBe(false);
    }
  });

  test("empty and missing race results cannot establish the pattern", () => {
    expect(hasTailscaleFailure(snapshot([]))).toBe(false);
    expect(hasTailscaleFailure({ routes: off, pending: false })).toBe(false);
  });

  test("a retry keeps the previous complete result until it finishes", () => {
    const retry = off.map((route) => ({ ...route, outcome: "probing" as const }));
    expect(hasTailscaleFailure({ ...snapshot(off), routes: retry, pending: true })).toBe(true);
  });

  test("request failures cannot replace successful probes in the race result", () => {
    const success = off.map((route, index) => (index === 0 ? { ...route, outcome: "ok" as const } : route));
    expect(hasTailscaleFailure({ ...snapshot(success), routes: off })).toBe(false);
    expect(hasTailscaleFailure(snapshot(off.map((route) => ({ ...route, phase: "request" }))))).toBe(false);
  });

  test("an active route clears guidance even if the previous race failed", () => {
    expect(hasTailscaleFailure({ ...snapshot(off), active: off[0]!.address })).toBe(false);
  });
});

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { RouteSelector, normalizedRoutes } from "../../apps/mobile/src/api/route-selector.ts";
import { ProbeError, type PinnedTransport } from "../../apps/mobile/src/api/routes.ts";

const first = "https://192.0.2.10:24443";
const second = "https://192.0.2.11:24443";
const fingerprint = "a".repeat(64);

afterEach(() => setSystemTime());

function policy() {
  const probes: string[] = [];
  const reachable = new Set([first, second]);
  let resets = 0;

  const transport: PinnedTransport = {
    async probe(address) {
      probes.push(address);

      if (!reachable.has(address)) throw new ProbeError("ECONNREFUSED");
    },
    async fetch() {
      throw new Error("Policy tests must not send an RPC");
    },
    reset() {
      resets++;
    },
  };

  return {
    selector: new RouteSelector({ fingerprint, addresses: [first, second] }, transport, () => false),
    probes,
    reachable,
    resets: () => resets,
  };
}

describe("sticky mobile route policy", () => {
  test("failed races share a growing cooldown across independent streams and unary requests", async () => {
    const { selector, probes, reachable } = policy();
    reachable.clear();
    setSystemTime(new Date(100_000));

    for (let attempt = 0; attempt < 8; attempt++) {
      await expect(selector.select()).rejects.toThrow("Cannot reach");
      const retryAt = selector.diagnostics.snapshot().retryAt!;
      const delay = retryAt - Date.now();
      expect(delay).toBeGreaterThanOrEqual(Math.min(30_000, 1000 * 2 ** attempt) * 0.8);
      expect(delay).toBeLessThanOrEqual(30_000);
      const count = probes.length;
      await Promise.all(Array.from({ length: 20 }, () => expect(selector.select()).rejects.toThrow("Cannot reach")));
      expect(probes.length).toBe(count);
      setSystemTime(new Date(retryAt));
    }

    reachable.add(first);
    selector.reset();
    const selected = await selector.select();
    selector.succeeded(selected);
    expect(selector.diagnostics.snapshot().retryAt).toBeUndefined();
  });

  test("a verified route survives hours of silence or stream activity without another race", async () => {
    const { selector, probes } = policy();
    const route = await selector.select();
    const diagnostics = selector.diagnostics.snapshot();

    for (const elapsed of [31_000, 300_000, 86_400_000]) {
      setSystemTime(new Date(Date.now() + elapsed));
      expect(await selector.select()).toBe(route);
      selector.succeeded(route); // Headers, data and heartbeat frames all use the same health path.
    }

    expect(probes).toEqual([first]);
    expect(selector.diagnostics.snapshot()).toBe(diagnostics);
    expect(selector.connection().lastAddress).toBe(first);
  });

  test("failure races again; late success or failure from an abandoned selection cannot replace the winner", async () => {
    const { selector, probes, reachable } = policy();
    const old = await selector.select();
    reachable.delete(first);
    selector.failedRequest(old, "timeout", Date.now());
    expect(selector.diagnostics.snapshot().active).toBeUndefined();
    const next = await selector.select();
    selector.succeeded(next);
    selector.succeeded(old);
    selector.failedRequest(old, "failed", Date.now());

    expect(await selector.select()).toBe(next);
    expect(next.address).toBe(second);
    expect(probes).toEqual([first, second]);
    expect(selector.connection().lastAddress).toBe(second);
    expect(selector.diagnostics.snapshot().active).toBe(second);
  });

  test("the reset path used by network change, foreground and Reconnect starts a fresh selection", async () => {
    const { selector, probes, resets } = policy();
    const old = await selector.select();
    selector.succeeded(old);
    selector.reset();
    const next = await selector.select();
    // Even the same address now belongs to a different connection selection.
    selector.failedRequest(old, "timeout", Date.now());
    selector.succeeded(old);

    expect(next).not.toBe(old);
    expect(await selector.select()).toBe(next);
    expect(probes).toEqual([first, first]);
    expect(resets()).toBe(1);
    expect(selector.diagnostics.snapshot().active).toBe(first);
  });

  test("new or reordered candidates keep the working route; removing it starts a new race", async () => {
    const { selector, probes, resets } = policy();
    const route = await selector.select();
    selector.succeeded(route);
    selector.update([second, first]);
    expect(await selector.select()).toBe(route);
    expect(selector.diagnostics.snapshot().active).toBe(first);
    expect(resets()).toBe(0);

    selector.update([second]);
    expect(selector.connection().lastAddress).toBeUndefined();
    expect((await selector.select()).address).toBe(second);
    expect(probes).toEqual([first, second]);
    expect(resets()).toBe(1);
  });

  test("old pairings drop private LAN .0 candidates, while public and tailnet host routes are preserved", () => {
    expect(
      normalizedRoutes([
        "https://10.20.1.0:24443",
        "https://172.20.1.0:24443",
        "https://192.168.50.0:24443",
        "https://10.20.1.9:24443",
        "https://100.64.0.0:24443",
        "https://192.0.2.0:24443",
        first,
        first,
      ]),
    ).toEqual(["https://10.20.1.9:24443", "https://100.64.0.0:24443", "https://192.0.2.0:24443", first]);
    expect(() => normalizedRoutes(["https://10.20.1.0:24443"])).toThrow();
  });
});

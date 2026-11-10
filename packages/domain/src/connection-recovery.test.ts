import { describe, expect, test } from "bun:test";
import { ConnectionRecovery, retryDelay, UNAVAILABLE_AFTER_MS } from "./connection-recovery";

describe("connection recovery hysteresis", () => {
  test("failed attempts latch unavailable; retries and network/foreground resets cannot clear it", () => {
    const recovery = new ConnectionRecovery();
    recovery.succeeded();
    recovery.begin(0);
    expect(recovery.snapshot.status).toBe("reconnecting");

    for (let attempt = 0; attempt < 3; attempt++) {
      recovery.begin(attempt * 1000);
      recovery.failed(attempt * 1000, 1);
    }

    expect(recovery.snapshot).toEqual({ status: "unavailable", retrying: false, retryAt: 6000 });

    for (let attempt = 0; attempt < 10; attempt++) {
      recovery.resetBackoff();
      expect(recovery.begin(3000 + attempt * 1000)).toEqual({
        status: "unavailable",
        retrying: true,
        retryAt: undefined,
      });
      expect(recovery.failed(3000 + attempt * 1000, 1).status).toBe("unavailable");
    }

    expect(recovery.succeeded()).toEqual({ status: "live", retrying: false, retryAt: undefined });
    expect(recovery.unavailableAt).toBeUndefined();
    recovery.begin(20_000);
    expect(recovery.failed(20_000, 1)).toEqual({ status: "reconnecting", retrying: false, retryAt: 21_000 });
  });

  test("a hanging connection becomes unavailable at the deadline, including across a retry reset", () => {
    const recovery = new ConnectionRecovery();
    recovery.begin(100);
    recovery.resetBackoff();
    recovery.begin(200);
    expect(recovery.check(100 + UNAVAILABLE_AFTER_MS - 1).status).toBe("reconnecting");
    expect(recovery.check(100 + UNAVAILABLE_AFTER_MS).status).toBe("unavailable");
    expect(recovery.begin(20_000).status).toBe("unavailable");
  });

  test("each successful outage recovery starts a fresh deadline, even for very short connections", () => {
    const recovery = new ConnectionRecovery();
    recovery.begin(0);
    recovery.check(12_000);
    recovery.succeeded();
    recovery.begin(12_001);
    expect(recovery.check(24_000).status).toBe("reconnecting");
    expect(recovery.check(24_001).status).toBe("unavailable");
  });

  test("backoff grows exponentially, has jitter, remains capped, and resets independently of availability", () => {
    const recovery = new ConnectionRecovery();
    expect(Array.from({ length: 8 }, (_, i) => retryDelay(i, 1))).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000,
    ]);

    for (let attempt = 0; attempt < 12; attempt++) {
      const upper = retryDelay(attempt, 1);
      expect(retryDelay(attempt, 0)).toBe(upper * 0.8);
      expect(retryDelay(attempt, 0.5)).toBeGreaterThan(retryDelay(attempt, 0));
      expect(upper).toBeLessThanOrEqual(30_000);
      recovery.begin(0);
      recovery.failed(0, 1);
    }

    expect(recovery.snapshot.retryAt).toBe(30_000);
    recovery.resetBackoff();
    expect(recovery.failed(0, 1)).toEqual({ status: "unavailable", retrying: false, retryAt: 1000 });
    recovery.succeeded();
    recovery.begin(0);
    expect(recovery.failed(0, 1).retryAt).toBe(1000);
  });
});

import { describe, expect, test, spyOn } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { watchPullRequest } from "../../apps/gateway/src/github/watch.ts";
import { startTestGateway } from "./support/gateway.ts";
import { linkedRead } from "./support/github-read.ts";
import { pollingFixture } from "./support/github-polling.ts";
import { PollingClock, measurePolling } from "./support/github-polling-clock.ts";

describe.skipIf(!dockerAvailable)("visible PR polling request budget", () => {
  for (const state of ["running", "completed", "merged", "closed"])
    test(`${state}: conditional budget includes renewals and the maintenance sweep`, async () => {
      const fixture = pollingFixture();
      fixture.state.running = state === "running";
      fixture.state.pr = ["running", "completed"].includes(state) ? "OPEN" : state.toUpperCase();
      const clock = new PollingClock(fixture);
      const random = spyOn(Math, "random").mockReturnValue(0.5);
      const gw = await startTestGateway({ github: { ...fixture.options, wait: clock.wait } });

      try {
        const { pr } = await linkedRead(gw, fixture);
        clock.onWait = () => gw.core.github.background.tick();
        const result = await measurePolling(gw.core.github.prs, pr, clock);
        console.info("PR polling measurement", state, JSON.stringify(result));
        expect(clock.elapsed).toBe(300_000);
        expect(result.second.total).toBe(0);
        expect(result.idle.total).toBe(result.idle.conditional);
        expect(result.idle.total).toBe(result.idle.notModified);
        expect(result.idle.ok).toBe(0);
        expect(result.idle.endpoints["CanopyPullRequest"]).toBeUndefined();
        expect(result.idle.endpoints["CanopyChecks"]).toBeUndefined();
        expect(result.idle.endpoints["CanopyTimeline"]).toBeUndefined();

        const budget =
          new Map([
            ["running", 25],
            ["completed", 5],
          ]).get(state) ?? 0;

        expect(result.idle.total).toBeLessThanOrEqual(budget);
        const hiddenAt = fixture.requests.length;

        for (let minute = 0; minute < 5; minute++) {
          fixture.advance(60_000);
          await gw.core.github.background.tick();
        }

        expect(fixture.requests).toHaveLength(hiddenAt);
      } finally {
        await gw.close();
        fixture.close();
        random.mockRestore();
      }
    }, 60_000);

  test("changed metadata invalidates pages, changed checks only reload checks, and manual refresh remains available", async () => {
    const fixture = pollingFixture();
    const clock = new PollingClock(fixture);
    const gw = await startTestGateway({ github: { ...fixture.options, wait: clock.wait } });

    try {
      const { pr } = await linkedRead(gw, fixture);
      const controller = new AbortController();

      const stream = watchPullRequest(
        gw.core.github.prs,
        create(github.WatchPullRequestRequestSchema, { pullRequestId: pr, visibility: "view" }),
        controller.signal,
      );

      await stream.next();
      const initial = fixture.requests.length;
      fixture.state.version++;
      fixture.advance(20_000);
      await gw.core.github.background.tick();
      const checks = (await stream.next()).value;
      expect(checks?.invalidated).toEqual(["checks"]);
      expect(checks?.snapshot?.summary?.checksState).toBe("pending");
      expect(checks?.snapshot?.summary?.checksCount).toBe(1);
      expect(fixture.requests.slice(initial).some((r) => r.resource === "CanopyChecks")).toBe(true);
      expect(fixture.requests.slice(initial).some((r) => r.resource === "CanopyPullRequest")).toBe(false);
      fixture.timelineVersion("changed");
      fixture.advance(60_000);
      await gw.core.github.background.tick();
      expect((await stream.next()).value?.invalidated).toContain("timeline");
      const before = fixture.requests.length;
      await gw.api.getPullRequest({ pullRequestId: pr, refresh: true });
      expect(fixture.requests.slice(before).some((r) => r.resource === "CanopyPullRequest")).toBe(true);
      controller.abort();
      await stream.return();
    } finally {
      await gw.close();
      fixture.close();
    }
  }, 60_000);

  test("legacy pending checks respect the server interval, then slow down and stop at merge", async () => {
    const fixture = pollingFixture();
    fixture.state.running = false;
    fixture.state.legacyRunning = true;
    fixture.state.pollInterval = 40;
    const gw = await startTestGateway({ github: fixture.options });
    const controller = new AbortController();

    try {
      const { pr } = await linkedRead(gw, fixture);

      const stream = watchPullRequest(
        gw.core.github.prs,
        create(github.WatchPullRequestRequestSchema, { pullRequestId: pr, visibility: "view" }),
        controller.signal,
      );

      await stream.next();
      const start = fixture.requests.length;
      fixture.advance(20_000);
      await gw.core.github.background.tick();
      expect(fixture.requests).toHaveLength(start);
      fixture.advance(21_000);
      await Promise.all([gw.core.github.background.tick(), gw.core.github.background.tick()]);
      expect(fixture.requests.slice(start).map((r) => r.resource)).toEqual([
        `/repos/itsoltech/canopy/commits/${fixture.state.head}/status`,
      ]);
      fixture.state.legacyRunning = false;
      fixture.advance(41_000);
      await gw.core.github.background.tick();
      const completed = fixture.requests.length;
      fixture.advance(20_000);
      await gw.core.github.background.tick();
      expect(fixture.requests).toHaveLength(completed);
      fixture.state.pr = "MERGED";
      fixture.state.updatedAt = "2026-11-10T12:02:00Z";
      await gw.api.getPullRequest({ pullRequestId: pr, refresh: true });
      await gw.core.github.background.tick();
      const merged = fixture.requests.length;
      fixture.advance(600_000);
      await gw.core.github.background.tick();
      expect(fixture.requests).toHaveLength(merged);
      controller.abort();
      await stream.return();
    } finally {
      controller.abort();
      await gw.close();
      fixture.close();
    }
  }, 60_000);

  test("hiding the last observer aborts a probe and starts no following requests", async () => {
    const fixture = pollingFixture();
    const upstream = fixture.options.fetch;
    const controller = new AbortController();
    let stopOnProbe = false;

    const transport: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);

        if (stopOnProbe && new URL(request.url).pathname.endsWith("/check-runs")) controller.abort();

        return upstream(request.url, init);
      },
      { preconnect: fetch.preconnect },
    );

    const gw = await startTestGateway({ github: { ...fixture.options, fetch: transport } });

    try {
      const { pr } = await linkedRead(gw, fixture);
      stopOnProbe = true;

      const stream = watchPullRequest(
        gw.core.github.prs,
        create(github.WatchPullRequestRequestSchema, { pullRequestId: pr, visibility: "view" }),
        controller.signal,
      );

      expect((await stream.next()).done).toBe(true);
      const hidden = fixture.requests.length;
      fixture.advance(300_000);
      await gw.core.github.background.tick();
      expect(fixture.requests).toHaveLength(hidden);
      expect(fixture.requests.some((r) => r.resource.endsWith("/status"))).toBe(false);
      await stream.return();
    } finally {
      controller.abort();
      await gw.close();
      fixture.close();
    }
  }, 60_000);
});

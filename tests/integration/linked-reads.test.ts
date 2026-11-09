import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { Provider, type ui } from "@canopy/contracts";
import { qualifyId } from "@canopy/domain/computers";
import { eventually } from "./support/gateway.ts";
import { linkedTimeouts } from "./support/linked-timeouts.ts";

describe.skipIf(!dockerAvailable)("reads and pushed changes across linked homes", () => {
  let f: Awaited<ReturnType<typeof linkedTimeouts>>;
  const calls = () => f.requests.get("ListModels") ?? 0;
  /** Linked reads this computer starts for ListModels (a refused or failing one still costs a peer request). */
  let reads = 0;

  beforeAll(async () => {
    f = await linkedTimeouts();
    const read = f.la.reads.read.bind(f.la.reads);

    f.la.reads.read = (node, method, ...rest) => {
      if (method.name === "ListModels") reads++;

      return read(node, method, ...rest);
    };
  }, 90_000);
  afterAll(async () => {
    await f?.close();
  }, 30_000);

  test("a local worker's catalog makes no linked-home RPC; a qualified worker reaches only its home", async () => {
    const before = calls();
    reads = 0;

    for (let n = 0; n < 5; n++) {
      const local = await f.a.api.listModels({ workerId: f.a.workerId });
      expect(local.workers.map((w) => w.workerId)).toEqual([f.a.workerId]);
    }

    await Bun.sleep(300);
    expect(reads).toBe(0);
    expect(calls()).toBe(before);

    const remoteWorker = qualifyId(f.b.workerId, f.node);
    const remote = await f.a.api.listModels({ workerId: remoteWorker });
    expect(remote.workers.every((w) => w.workerId === remoteWorker)).toBe(true);
    expect(calls()).toBe(before + 1);
  });

  test("an unscoped catalog still includes every reachable home", async () => {
    const all = await eventually(
      () => f.a.api.listModels({}),
      (response) => response.workers.some((w) => w.workerId === qualifyId(f.b.workerId, f.node)),
    );

    expect(all.workers.map((w) => w.workerId)).toContain(f.a.workerId);
  });

  test("a linked home's bot changes reach this computer's subscribers with qualified ids", async () => {
    const abort = new AbortController();
    const updates: ui.OverviewUpdate[] = [];

    const reading = (async () => {
      for await (const update of f.a.api.watchOverview({}, { signal: abort.signal })) updates.push(update);
    })().catch(() => {});

    try {
      const pushed = await eventually(
        async () => updates.flatMap((u) => (u.change.case === "feeds" ? [u.change.value.pushed] : [])).at(-1),
        (feeds) => !!feeds?.includes("bots"),
        10_000,
      );

      expect(pushed).toContain("bots");
      await Bun.sleep(2500);

      const bot = (
        await f.b.api.createBot({
          clientRequestId: crypto.randomUUID(),
          configuration: {
            name: "Studio bot",
            shape: "round",
            color: "#22aaff",
            provider: Provider.CODEX,
            providerInstance: "native",
            model: "gpt-6.1-sol",
            workerId: f.b.workerId,
          },
        })
      ).bot!;

      const remote = qualifyId(bot.id, f.node);

      const seen = await eventually(
        async () => updates.find((u) => u.change.case === "bot" && u.change.value.id === remote),
        Boolean,
        5000,
      );

      expect(seen?.change.case).toBe("bot");
      await f.b.api.deleteBot({ botId: bot.id });
      await eventually(
        async () => updates.some((u) => u.change.case === "botRemoved" && u.change.value === remote),
        Boolean,
        5000,
      );
    } finally {
      abort.abort();
      await reading;
    }
  }, 30_000);

  test("a peer read that returns the same answer announces nothing, so clients read nothing again", async () => {
    const completed: string[] = [];
    const stop = f.la.reads.subscribe((method) => completed.push(method));

    try {
      // The first answer is new: it is announced.
      await f.a.api.listSchedules({});
      await eventually(
        async () => completed.filter((m) => m === "ListSchedules").length,
        (n) => n > 0,
        5000,
      );
      const first = completed.filter((m) => m === "ListSchedules").length;
      await Bun.sleep(5600);
      await f.a.api.listSchedules({});
      await Bun.sleep(800);
      expect(completed.filter((m) => m === "ListSchedules").length).toBe(first);
    } finally {
      stop();
    }
  }, 20_000);
});

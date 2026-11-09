import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { qualifyId } from "@canopy/domain/computers";
import { eventually } from "./support/gateway.ts";
import { linkedTimeouts } from "./support/linked-timeouts.ts";

describe.skipIf(!dockerAvailable)("model catalog routing across linked homes", () => {
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
});

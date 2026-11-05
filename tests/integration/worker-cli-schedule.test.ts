import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { WorkerConfigSchema } from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import type { CheckClock } from "@canopy/domain/update-checks";
import { Journal } from "@canopy/worker/journal";
import { WorkerHost } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { join } from "node:path";

class FakeClock implements CheckClock {
  time = 1_000;
  jobs = new Set<{ at: number; run: () => void }>();
  now = () => this.time;
  schedule(run: () => void, delay: number): () => void {
    const job = { at: this.time + delay, run };
    this.jobs.add(job);

    return () => this.jobs.delete(job);
  }
  async advance(minutes: number): Promise<void> {
    this.time += minutes * 60_000;

    for (const job of this.jobs)
      if (job.at <= this.time) {
        this.jobs.delete(job);
        job.run();
      }

    // Flush discovery, report serialization, and the timer's promise continuation.
    for (let i = 0; i < 30; i++) await Promise.resolve();
  }
}

test("real worker applies CLI interval changes, cancels old timers and Never, and stops on shutdown", async () => {
  const root = tempDir("canopy-cli-schedule-");
  const runtime = ManagedRuntime.make(Journal.layer(join(root, "journal.db")));
  const clock = new FakeClock();
  let probes = 0;

  const host = new WorkerHost({
    runtime,
    dataDir: root,
    clientVersion: "test",
    cliCheckClock: clock,
    cliProbe: {
      platform: "linux",
      home: root,
      docker: true,
      locate: () => {
        probes++;

        return [];
      },
      which: () => null,
      realpath: () => undefined,
      version: async () => ({ error: "not installed" }),
    },
  });

  const config = (minutes: number, version: bigint) =>
    create(WorkerConfigSchema, {
      version,
      cliUpdateCheckMinutes: minutes,
      claude: { enabled: false },
      codex: { enabled: false },
      grok: { enabled: false },
    });

  try {
    expect((await host.applyConfig(config(60, 1n))).applied).toBe(true);
    await clock.advance(59);
    expect(probes).toBe(0);
    await clock.advance(1);
    expect(probes).toBeGreaterThan(0);
    const before = probes;
    await host.applyConfig(config(0, 2n));
    await clock.advance(8 * 24 * 60);
    expect(probes).toBe(before);
    await host.applyConfig(config(360, 3n));
    await clock.advance(359);
    expect(probes).toBe(before);
    await clock.advance(1);
    expect(probes).toBeGreaterThan(before);
  } finally {
    await host.close();
    await runtime.dispose();
  }

  expect(clock.jobs.size).toBe(0);
});

import { expect, test } from "bun:test";
import { tempDir } from "@canopy/testing";
import { UpdateCheckSettings } from "../src/update-check-settings.ts";
import { UpdateCheckTimer, type CheckClock } from "@canopy/domain/update-checks";

test("desktop update frequency and last check survive restart; Never cancels scheduled automatic work", async () => {
  const directory = tempDir("canopy-update-checks-");
  const settings = new UpdateCheckSettings(directory);
  expect(settings.minutes).toBe(360);
  settings.save(0, 1234);
  const restarted = new UpdateCheckSettings(directory);
  expect(restarted.minutes).toBe(0);
  expect(restarted.lastChecked).toBe(1234);
  expect(() => restarted.save(12)).toThrow("frequency");
  let now = 1_000;
  let pending: (() => void) | undefined;
  let delay = 0;

  const clock: CheckClock = {
    now: () => now,
    schedule: (run, wait) => {
      pending = run;
      delay = wait;

      return () => {
        pending = undefined;
      };
    },
  };

  const timer = new UpdateCheckTimer(clock);
  let checks = 0;

  const run = async () => {
    checks++;
    // Downloading takes time, but the next check still matches the persisted start timestamp.
    now += 5 * 60_000;
  };

  timer.start(60, now, run);
  expect(delay).toBe(3_600_000);
  now += delay;
  pending?.();

  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(checks).toBe(1);
  expect(delay).toBe(55 * 60_000);
  timer.start(0, now, run);
  expect(pending).toBeUndefined();
  // A manual operation is independent of the automatic schedule.
  await run();
  expect(checks).toBe(2);
  timer.stop();
});

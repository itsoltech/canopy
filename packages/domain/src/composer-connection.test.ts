import { afterEach, describe, expect, jest, test } from "bun:test";
import { ComposerConnection, COMPOSER_DISCONNECT_GRACE_MS } from "./composer-connection";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { threadWatchReady } from "./thread-watch-state";

afterEach(() => jest.useRealTimers());

describe("composer availability during watch recovery", () => {
  test("controls preserve readiness without confirming an unfinished sequence catch-up", () => {
    jest.useFakeTimers();
    const connection = new ComposerConnection();

    const receive = (update: ui.ThreadUpdate) => {
      const ready = threadWatchReady(update);

      if (ready !== null) connection.update(ready);
    };

    const controls = create(ui.ThreadUpdateSchema, { change: { case: "controls", value: {} } });
    receive(controls);
    expect(connection.live).toBe(false);
    receive(create(ui.ThreadUpdateSchema, { change: { case: "batch", value: { caughtUp: false } } }));
    receive(controls);
    expect(connection.composerAvailable).toBe(false);
    receive(create(ui.ThreadUpdateSchema, { change: { case: "batch", value: { caughtUp: true } } }));

    for (let tick = 0; tick < 3; tick++) {
      jest.advanceTimersByTime(5000);
      receive(controls);
      expect(connection.live).toBe(true);
      expect(connection.composerAvailable).toBe(true);
    }

    receive(create(ui.ThreadUpdateSchema, { syncing: true }));
    receive(controls);
    expect(connection.live).toBe(false);
    jest.advanceTimersByTime(COMPOSER_DISCONNECT_GRACE_MS);
    expect(connection.composerAvailable).toBe(false);
    connection.reset();
  });

  test("brief disconnects do not disable the composer, but a sustained loss does", () => {
    jest.useFakeTimers();
    const connection = new ComposerConnection();
    const availability: boolean[] = [];
    connection.subscribe(() => {
      if (availability.at(-1) !== connection.composerAvailable) availability.push(connection.composerAvailable);
    });
    expect(connection.composerAvailable).toBe(false);
    connection.update(true);

    for (const duration of [50, 100, 150]) {
      connection.update(false);
      jest.advanceTimersByTime(duration);
      expect(connection.composerAvailable).toBe(true);
      connection.update(true);
      jest.advanceTimersByTime(COMPOSER_DISCONNECT_GRACE_MS);
    }

    expect(availability).toEqual([true]);
    connection.update(false);
    jest.advanceTimersByTime(900);
    // Repeated non-live updates cannot move the deadline.
    connection.update(false);
    jest.advanceTimersByTime(100);
    expect(connection.composerAvailable).toBe(false);
    connection.update(true);
    expect(availability).toEqual([true, false, true]);
    connection.reset();
  });

  test("delivery waits for synchronization even while presentation remains enabled", async () => {
    jest.useFakeTimers();
    const connection = new ComposerConnection();
    const controller = new AbortController();
    connection.update(true);
    connection.update(false);
    let delivered = false;

    const delivery = connection.waitUntilLive(controller.signal).then(() => {
      delivered = true;
    });

    jest.advanceTimersByTime(150);
    await Promise.resolve();
    expect(connection.composerAvailable).toBe(true);
    expect(delivered).toBe(false);
    connection.update(true);
    await delivery;
    expect(delivered).toBe(true);
    connection.reset();
  });

  test("leaving a thread cancels queued delivery and clears the grace timer", async () => {
    jest.useFakeTimers();
    const connection = new ComposerConnection();
    const controller = new AbortController();
    connection.update(true);
    connection.update(false);
    const pending = connection.waitUntilLive(controller.signal);
    controller.abort();
    connection.reset();
    jest.advanceTimersByTime(COMPOSER_DISCONNECT_GRACE_MS);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(connection.composerAvailable).toBe(false);
  });
});

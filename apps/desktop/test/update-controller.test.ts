import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { CancellationToken } from "electron-updater/out/types.js";
import type { UpdateCheckResult } from "electron-updater";
import type { CheckClock } from "@canopy/domain/update-checks";
import { UpdateController, type Updater } from "../src/update-controller.ts";
import { RemoteAppUpdate } from "../src/remote-app-update.ts";
import { tempDir } from "@canopy/testing";
import { join } from "node:path";
import { create, toJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { writeFileSync } from "node:fs";

class Clock implements CheckClock {
  time = 0;
  timers = new Set<{ run: () => void; at: number }>();
  now = () => this.time;
  schedule(run: () => void, delay: number) {
    const timer = { run, at: this.time + delay };
    this.timers.add(timer);

    return () => {
      this.timers.delete(timer);
    };
  }
  advance(ms: number, asleep = false) {
    this.time += ms;

    if (asleep) return;

    for (const timer of this.timers) {
      if (timer.at > this.time) continue;
      this.timers.delete(timer);
      timer.run();
    }
  }
}

class FakeUpdater extends EventEmitter implements Updater {
  channel = "nightly";
  allowPrerelease = true;
  allowDowngrade = false;
  autoDownload = false;
  autoInstallOnAppQuit = false;
  token = new CancellationToken();
  version = "0.3.0-nightly.2";
  check: () => Promise<UpdateCheckResult | null> = async () => {
    this.emit("update-available", { version: this.version });

    return this.result();
  };
  result(): UpdateCheckResult {
    const info = { version: this.version, files: [], releaseDate: "", path: "fixture", sha512: "fixture" };

    return {
      isUpdateAvailable: true,
      updateInfo: info,
      versionInfo: info,
      cancellationToken: this.token,
    };
  }
  download: () => Promise<string[]> = async () => {
    this.emit("update-downloaded", { version: this.version });

    return [];
  };
  checkForUpdates() {
    return this.check();
  }
  downloadUpdate() {
    return this.download();
  }
}

function fixture() {
  const clock = new Clock();
  const updaters = [new FakeUpdater()];
  let prepare: (signal: AbortSignal) => Promise<boolean> = async () => true;

  const controller = new UpdateController(updaters[0]!, {
    version: "0.3.0-nightly.1",
    buildChannel: "nightly",
    channel: "nightly",
    clock,
    timeouts: { prepare: 60, check: 60, download: 300, stall: 90 },
    recover: () => {
      const updater = new FakeUpdater();
      updaters.push(updater);

      return updater;
    },
    prepare: (_channel, _downgrade, signal) => prepare(signal),
    save() {},
    confirmDowngrade: async () => true,
    changed() {},
    downloaded() {},
  });

  controller.enable();

  return {
    controller,
    clock,
    updaters,
    prepare: (run: typeof prepare) => {
      prepare = run;
    },
  };
}

test("remote, manual and automatic checks share a running check and report its actual progress", async () => {
  const { controller, prepare, updaters } = fixture();
  const ready = Promise.withResolvers<boolean>();
  prepare(() => ready.promise);
  const first = controller.checkAutomatically();
  expect(controller.checkRemote()).toBe(first);
  expect(controller.check()).toBe(first);
  expect(controller.status().phase).toBe("checking");
  const downloading = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<string[]>();
  const updater = updaters[0]!;
  updater.download = () => {
    downloading.resolve();

    return finish.promise;
  };

  ready.resolve(true);
  await downloading.promise;
  updater.emit("download-progress", { percent: 40, transferred: 40 });
  expect(controller.status()).toMatchObject({ phase: "downloading", progress: 40, error: undefined });
  expect(controller.checkRemote()).toBe(first);
  updater.emit("update-downloaded", { version: updater.version });
  finish.resolve([]);
  expect(await first).toMatchObject({ phase: "downloaded", stagedVersion: updater.version });
});

test("a hung prepare times out, aborts its request and releases the running check", async () => {
  const { controller, prepare, clock, updaters } = fixture();
  const hung = Promise.withResolvers<boolean>();
  let signal: AbortSignal | undefined;
  prepare((value) => {
    signal = value;

    return hung.promise;
  });
  const first = controller.check();
  clock.advance(60);
  expect(await first).toMatchObject({ phase: "error", error: "Update timed out. Check the connection, then retry." });
  expect(signal?.aborted).toBe(true);
  prepare(async () => true);
  expect(await controller.checkRemote()).toMatchObject({ phase: "downloaded" });
  hung.resolve(true);
  await Promise.resolve();
  expect(controller.status().phase).toBe("downloaded");
  expect(updaters).toHaveLength(2);
  expect(clock.timers.size).toBe(0);
});

test("a hung metadata check times out and its late events cannot replace the next attempt", async () => {
  const { controller, clock, updaters } = fixture();
  const entered = Promise.withResolvers<void>();
  const hung = Promise.withResolvers<UpdateCheckResult | null>();
  const old = updaters[0]!;
  old.check = () => {
    entered.resolve();

    return hung.promise;
  };

  const first = controller.check();
  await entered.promise;
  clock.advance(60);
  expect((await first).phase).toBe("error");
  const retry = controller.checkRemote();
  old.emit("error", new Error("late failure"));
  old.emit("update-downloaded", { version: "99.0.0" });
  expect(await retry).toMatchObject({ phase: "downloaded", stagedVersion: "0.3.0-nightly.2" });
  hung.resolve(old.result());
  await Promise.resolve();
  expect(old.token.cancelled).toBe(true);
  expect(controller.status().stagedVersion).toBe("0.3.0-nightly.2");
});

test("resume cancels a stale download and the original remote caller waits for its replacement", async () => {
  const { controller, clock, updaters } = fixture();
  const entered = Promise.withResolvers<void>();
  const hung = Promise.withResolvers<string[]>();
  const old = updaters[0]!;
  old.download = () => {
    entered.resolve();

    return hung.promise;
  };

  const checking = controller.checkAutomatically();
  await entered.promise;
  clock.advance(100, true);
  expect(controller.resume()).toBe(checking);
  expect(controller.resume()).toBe(checking);
  expect(controller.checkRemote()).toBe(checking);
  expect(await checking).toMatchObject({ phase: "downloaded", error: undefined });
  expect(old.token.cancelled).toBe(true);
  expect(updaters).toHaveLength(2);
  old.emit("download-progress", { percent: 5, transferred: 5 });
  old.emit("update-downloaded", { version: "99.0.0" });
  hung.resolve([]);
  await Promise.resolve();
  expect(controller.status()).toMatchObject({ phase: "downloaded", stagedVersion: "0.3.0-nightly.2" });
  expect(clock.timers.size).toBe(0);
});

test("download progress extends the stall deadline, but repeated bytes do not", async () => {
  const { controller, clock, updaters } = fixture();
  const entered = Promise.withResolvers<void>();
  const old = updaters[0]!;
  old.download = () => {
    entered.resolve();

    return new Promise(() => {});
  };

  const checking = controller.check();
  await entered.promise;
  clock.advance(80);
  old.emit("download-progress", { percent: 40, transferred: 40 });
  clock.advance(80);
  expect(controller.resume()).toBe(checking);
  old.emit("download-progress", { percent: 40, transferred: 40 });
  clock.advance(10);
  expect((await checking).phase).toBe("error");
  expect(old.token.cancelled).toBe(true);
  expect((await controller.check()).phase).toBe("downloaded");
});

test("exceptions in prepare, checking and download always release the operation", async () => {
  for (const stage of ["prepare", "check", "download"] as const) {
    const { controller, prepare, updaters } = fixture();

    const fail = async (): Promise<never> => {
      throw new Error("fixture failure");
    };

    if (stage === "prepare") prepare(fail);
    else updaters[0]![stage] = fail;
    expect((await controller.check()).phase).toBe("error");
    prepare(async () => false);
    expect(await controller.checkRemote()).toMatchObject({ phase: "idle", error: undefined });
  }
});

test("a channel change waits for the current check and remote checks join the queued change", async () => {
  const { controller, prepare } = fixture();
  const ready = Promise.withResolvers<boolean>();
  prepare(() => ready.promise);
  const checking = controller.check();
  const switching = controller.setChannel("beta");
  expect(controller.checkRemote()).toBe(switching);
  expect(controller.status().channel).toBe("nightly");
  ready.resolve(false);
  await checking;
  expect(await switching).toMatchObject({ channel: "beta", changingChannel: false, phase: "idle" });
});

test("a remote installation during an automatic download keeps checking/downloading instead of failing as busy", async () => {
  const { controller, updaters } = fixture();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<string[]>();
  const updater = updaters[0]!;
  updater.download = () => {
    entered.resolve();

    return finish.promise;
  };

  const checking = controller.checkAutomatically();
  await entered.promise;

  const remote = new RemoteAppUpdate(join(tempDir("canopy-busy-update-"), "update.json"), {
    status: () => controller.status(),
    check: () => controller.checkRemote(),
    drain: async () => false,
    notify() {},
    restart() {},
    report: async () => {},
  });

  try {
    const installing = remote.command(create(ui.DesktopUpdateCommandSchema, { requestId: "fixture" }));
    updater.emit("download-progress", { percent: 40, transferred: 40 });
    remote.changed();
    expect(remote.snapshot()).toMatchObject({
      phase: "downloading",
      updaterPhase: "downloading",
      updaterProgress: 40,
      reason: "",
    });
    updater.emit("update-downloaded", { version: updater.version });
    finish.resolve([]);
    await checking;
    await installing;
    expect(remote.snapshot()).toMatchObject({ phase: "waiting_idle", ready: true, updaterPhase: "downloaded" });
  } finally {
    remote.stop();
  }
});

test("continuous download progress cannot bypass the total timeout", async () => {
  const { controller, clock, updaters } = fixture();
  const entered = Promise.withResolvers<void>();
  const updater = updaters[0]!;
  updater.download = () => {
    entered.resolve();

    return new Promise(() => {});
  };

  const checking = controller.check();
  await entered.promise;

  for (let transferred = 1; transferred <= 4; transferred++) {
    clock.advance(70);
    updater.emit("download-progress", { percent: transferred, transferred });
  }

  clock.advance(20);
  expect((await checking).phase).toBe("error");
  expect(updater.token.cancelled).toBe(true);
  expect(clock.timers.size).toBe(0);
});

test("wake retries a check whose timeout ran first, while Never leaves it available for manual retry", async () => {
  for (const automatic of [true, false]) {
    const { controller, clock, prepare } = fixture();
    prepare(() => new Promise(() => {}));
    const checking = controller.check();
    clock.advance(60);
    await checking;
    prepare(async () => true);
    controller.setAutomaticUpdates(automatic);
    await controller.resume();
    expect(controller.status().phase).toBe(automatic ? "downloaded" : "error");

    if (!automatic) expect((await controller.checkRemote()).phase).toBe("downloaded");
  }
});

test("a stalled replacement preserves the previously staged version for restart", async () => {
  const { controller, clock, updaters } = fixture();
  await controller.check();
  const updater = updaters[0]!;
  updater.version = "0.3.0-nightly.3";
  const entered = Promise.withResolvers<void>();
  updater.download = () => {
    entered.resolve();

    return new Promise(() => {});
  };

  const checking = controller.check();
  await entered.promise;
  clock.advance(90);
  expect(await checking).toMatchObject({
    phase: "downloaded",
    stagedVersion: "0.3.0-nightly.2",
    error: "Update timed out. Check the connection, then retry.",
  });
  expect(await controller.prepareInstall()).toBe(true);
});

test("persisted overlap reports the live peer phase while genuine installation failures remain failed", async () => {
  const { controller, prepare } = fixture();
  const ready = Promise.withResolvers<boolean>();
  prepare(() => ready.promise);
  const checking = controller.check();
  const path = join(tempDir("canopy-busy-history-"), "update.json");

  const boundary = {
    status: () => controller.status(),
    check: () => controller.checkRemote(),
    drain: async () => false,
    notify() {},
    restart() {},
    report: async () => {},
  };

  for (const reason of [
    "Wait for the current app update operation to finish, then retry.",
    "Fixture installation failed.",
  ]) {
    writeFileSync(
      path,
      toJsonString(
        ui.DesktopUpdateStateSchema,
        create(ui.DesktopUpdateStateSchema, {
          requestId: "old-request",
          phase: "failed",
          reason,
        }),
      ),
    );
    const remote = new RemoteAppUpdate(path, boundary);
    expect(remote.snapshot()).toMatchObject({
      phase: reason.startsWith("Wait") ? "idle" : "failed",
      updaterPhase: "checking",
      reason: reason.startsWith("Wait") ? "" : reason,
    });
    remote.stop();
  }

  ready.resolve(false);
  await checking;
});

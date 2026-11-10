import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { tempDir } from "@canopy/testing";
import { newestRelease, releaseNotes, type DesktopRelease } from "../src/update-releases.ts";
import { mergeDesktopUpdates } from "../scripts/merge-update-metadata.ts";
import { AppUpdater, type DownloadUpdateOptions, type DownloadExecutorTask } from "electron-updater/out/AppUpdater.js";
import { NodeHttpExecutor } from "builder-util/out/nodeHttpExecutor.js";
import { UpdateController } from "../src/update-controller.ts";
import { UpdateSettings } from "../src/update-settings.ts";
import type { DesktopChannel } from "../src/identity.ts";
import { channelFeed } from "../src/update-releases.ts";
import { StagedDownloads } from "../src/staged-downloads.ts";
import { UpdateCheckTimer } from "@canopy/domain/update-checks";
import { CancellationError } from "builder-util-runtime";
import { installAppUpdate, checkWindowsUpdateInstall, WINDOWS_UPDATE_ADMIN_MESSAGE } from "../src/update-install.ts";
import { RemoteAppUpdate } from "../src/remote-app-update.ts";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";

const { machOFiles } = require("../scripts/macho.cjs") as { machOFiles: (directory: string) => string[] };

function release(tag: string, feed: string, prerelease = true): DesktopRelease {
  return { tag_name: tag, draft: false, prerelease, assets: [{ name: feed }, { name: "manifest.json" }] };
}

test("selected channels include newer stable releases and reject prerelease leaks, drafts and incomplete releases", () => {
  const releases = [
    {
      ...release("v0.4.0", "latest-mac.yml", false),
      assets: [
        { name: "latest-mac.yml" },
        { name: "beta-mac.yml" },
        { name: "nightly-mac.yml" },
        { name: "manifest.json" },
      ],
    },
    release("v0.5.0-nightly.9", "nightly-mac.yml"),
    release("v0.3.0-beta.1", "beta-mac.yml"),
    release("v0.3.0-beta.2", "beta-mac.yml"),
    { ...release("v0.3.0-beta.3", "beta-mac.yml"), draft: true },
    { ...release("v0.3.0-beta.4", "beta-mac.yml"), assets: [{ name: "beta-mac.yml" }] },
    release("not-a-version", "beta-mac.yml"),
  ];

  expect(newestRelease(releases, "0.3.0-beta.1", "beta", "beta-mac.yml")?.tag_name).toBe("v0.4.0");
  expect(newestRelease(releases, "0.4.0", "beta", "beta-mac.yml")).toBeUndefined();
  expect(newestRelease(releases, "0.4.0", "stable", "latest-mac.yml")).toBeUndefined();
  expect(newestRelease(releases, "0.4.0-nightly.1", "nightly", "nightly-mac.yml")?.tag_name).toBe("v0.5.0-nightly.9");
  expect(newestRelease(releases, "0.5.0-nightly.9", "stable", "latest-mac.yml", true)?.tag_name).toBe("v0.4.0");
});

test("mac update metadata preserves both runner architectures and rejects mismatched content", async () => {
  const directory = tempDir("canopy-desktop-feeds-");
  const source = join(directory, "artifacts");

  for (const arch of ["arm64", "x64"]) {
    const artifact = join(source, `desktop-darwin-${arch}`);
    mkdirSync(artifact, { recursive: true });
    const name = `Canopy-0.3.0-beta.1-darwin-${arch}.zip`;
    const contents = Buffer.from(`fixture ${arch}`);
    const sha512 = createHash("sha512").update(contents).digest("base64");
    writeFileSync(join(artifact, name), contents);
    writeFileSync(
      join(artifact, "beta-mac.yml"),
      JSON.stringify({ version: "0.3.0-beta.1", files: [{ url: name, sha512 }], path: name, sha512 }),
    );
    writeFileSync(join(artifact, `package-sizes-darwin-${arch}.json`), "{}");
  }

  const output = join(directory, "assets");
  await mergeDesktopUpdates(source, output, "beta", "0.3.0-beta.1");
  expect(existsSync(join(output, "package-sizes-darwin-arm64.json"))).toBe(false);
  const feed = load(readFileSync(join(output, "beta-mac.yml"), "utf8")) as { files: { url: string }[] };
  expect(feed.files.map((file) => file.url).sort()).toEqual([
    "Canopy-0.3.0-beta.1-darwin-arm64.zip",
    "Canopy-0.3.0-beta.1-darwin-x64.zip",
  ]);
  expect(readFileSync(join(output, "nightly-mac.yml"), "utf8")).toBe(
    readFileSync(join(output, "beta-mac.yml"), "utf8"),
  );
  await expect(
    mergeDesktopUpdates(source, join(directory, "wrong-channel"), "nightly", "0.3.0-beta.1"),
  ).rejects.toThrow("Unexpected");
  const arm = join(source, "desktop-darwin-arm64", "Canopy-0.3.0-beta.1-darwin-arm64.zip");
  writeFileSync(arm, "corrupt download");
  await expect(mergeDesktopUpdates(source, join(directory, "corrupt"), "beta", "0.3.0-beta.1")).rejects.toThrow(
    "checksum",
  );
});

/** Real electron-updater version checks and GenericProvider HTTP; only binary installation is stubbed. */
class FeedUpdater extends AppUpdater {
  readonly downloads: { version: string; downgrade: boolean }[] = [];
  readonly installed: string[] = [];
  readonly installOptions: { silent: boolean; forceRun: boolean }[] = [];
  private readonly staged = new StagedDownloads();
  beforeDownload: () => Promise<void> = async () => {};
  failDownload = false;
  failAfterDownloaded = false;
  constructor(version: string, directory: string) {
    super(null, {
      version,
      name: "Canopy",
      isPackaged: true,
      userDataPath: directory,
      baseCachePath: directory,
      appUpdateConfigPath: join(directory, "unused.yml"),
      whenReady: async () => {},
      relaunch() {},
      quit() {},
      onQuit() {},
    });
    Object.assign(this, { httpExecutor: new NodeHttpExecutor() });
    this.logger = null;
    writeFileSync(join(directory, "unused.yml"), JSON.stringify({ updaterCacheDirName: "cache" }));
  }
  protected override executeDownload(task: DownloadExecutorTask) {
    return this.staged.run(
      this.downloadedUpdateHelper,
      (helper) => {
        this.downloadedUpdateHelper = helper;
      },
      () => super.executeDownload(task),
    );
  }
  protected async doDownloadUpdate(options: DownloadUpdateOptions) {
    const info = options.updateInfoAndProvider.info;
    const file = options.updateInfoAndProvider.provider.resolveFiles(info)[0];

    if (!file) throw new Error("Missing fixture file");
    this.downloads.push({ version: info.version, downgrade: this.allowDowngrade });

    return this.executeDownload({
      fileExtension: "AppImage",
      fileInfo: file,
      downloadUpdateOptions: options,
      task: async (destination) => {
        await this.beforeDownload();

        if (options.cancellationToken.cancelled) throw new CancellationError();
        writeFileSync(destination, `fixture ${info.version}`);
        this.emit("download-progress", { percent: 50, total: 100, transferred: 50, delta: 50, bytesPerSecond: 50 });

        if (this.failDownload) throw new Error("Fixture download failed");
      },
      done: async (event) => {
        this.dispatchUpdateDownloaded(event);

        if (this.failAfterDownloaded) throw new Error("Fixture finalization failed");
      },
    });
  }
  quitAndInstall(silent = false, forceRun = false) {
    const file = this.downloadedUpdateHelper?.file;

    if (!file) throw new Error("No staged fixture");
    this.installOptions.push({ silent, forceRun });
    this.installed.push(readFileSync(file, "utf8"));
  }
}

async function localFeeds() {
  const directory = tempDir("canopy-updater-http-");
  const releases: DesktopRelease[] = [];

  async function publish(channel: DesktopChannel, version: string) {
    const source = join(directory, `${version}-source`, "desktop-linux-x64");
    mkdirSync(source, { recursive: true });
    const name = `Canopy-${version}-linux-x64.AppImage`;
    const contents = Buffer.from(`fixture ${version}`);
    const sha512 = createHash("sha512").update(contents).digest("base64");
    writeFileSync(join(source, name), contents);
    writeFileSync(
      join(source, `${channelFeed(channel)}-linux.yml`),
      JSON.stringify({ version, files: [{ url: name, sha512, size: contents.length }], path: name, sha512 }),
    );
    const destination = join(directory, `v${version}`);
    await mergeDesktopUpdates(join(directory, `${version}-source`), destination, channel, version);
    releases.push({
      tag_name: `v${version}`,
      draft: false,
      prerelease: channel !== "stable",
      assets: [
        ...(channel === "stable"
          ? ["latest", "beta", "nightly"]
          : channel === "beta"
            ? ["beta", "nightly"]
            : ["nightly"]
        ).map((feed) => ({ name: `${feed}-linux.yml` })),
        { name: "manifest.json" },
      ],
    });
  }

  await publish("stable", "0.4.0");
  await publish("beta", "0.5.0-beta.1");
  await publish("nightly", "0.6.0-nightly.1");

  const requests: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);

      if (!/^\/v[\w.-]+\/(latest|beta|nightly)-linux.yml$/.test(path))
        return new Response("Not found", { status: 404 });

      return new Response(Bun.file(join(directory, path)));
    },
  });

  function fixture(
    version: string,
    buildChannel: DesktopChannel,
    confirm: () => Promise<boolean>,
    beforeInstall = () => {},
  ) {
    const data = tempDir("canopy-update-settings-");
    const settings = new UpdateSettings(data);
    const updater = new FeedUpdater(version, data);
    const phases: string[] = [];

    const controller = new UpdateController(updater, {
      recover: () => updater,
      version,
      buildChannel,
      channel: settings.read(buildChannel),
      save: (channel) => settings.write(channel),
      confirmDowngrade: confirm,
      prepare: async (channel, downgrade) => {
        const release = newestRelease(releases, version, channel, `${channelFeed(channel)}-linux.yml`, downgrade);

        if (!release) return false;
        updater.setFeedURL({
          provider: "generic",
          url: `${server.url}${release.tag_name}/`,
          channel: channelFeed(channel),
        });

        return {
          available: true,
          releases: releaseNotes(releases, version, release.tag_name, channel),
          publishing: undefined,
        };
      },
      changed: () => phases.push(controller.status().phase),
      downloaded() {},
      beforeInstall,
    });

    controller.enable();

    return { controller, updater, settings, phases };
  }

  return { server, requests, fixture, publish };
}

for (const platform of ["win32", "darwin", "linux"] as const) {
  test(`local ${platform} restart installs the staged update with the platform's silent and relaunch flags`, async () => {
    const { server, fixture } = await localFeeds();

    try {
      const { controller, updater } = fixture("0.6.0-nightly.0", "nightly", async () => false);
      await controller.check();
      expect(await controller.prepareInstall()).toBe(true);
      installAppUpdate(updater, platform);
      expect(updater.installed).toEqual(["fixture 0.6.0-nightly.1"]);
      expect(updater.installOptions).toEqual([{ silent: platform === "win32", forceRun: true }]);
    } finally {
      await server.stop(true);
    }
  });
}

for (const requestedBy of ["", "Office computer"]) {
  test(`Windows remote update from ${requestedBy || "gateway"} installs silently and reports success after relaunch`, async () => {
    const { server, fixture } = await localFeeds();
    const { controller, updater } = fixture("0.6.0-nightly.0", "nightly", async () => false);
    const path = join(tempDir("canopy-silent-update-"), "remote-update.json");
    let version = controller.status().version;
    const reports: ui.DesktopUpdateState[] = [];

    const boundary = {
      status: () => ({ ...controller.status(), version }),
      check: () => controller.checkRemote(),
      prepareRestart: async () => ((await controller.prepareInstall()) ? controller.status() : undefined),
      drain: async () => true,
      notify() {},
      report: async (state: ui.DesktopUpdateState) => {
        reports.push(state);
      },
      restart() {
        installAppUpdate(updater, "win32");
        version = controller.status().stagedVersion!;
      },
    };

    const remote = new RemoteAppUpdate(path, boundary);

    try {
      await remote.command(create(ui.DesktopUpdateCommandSchema, { requestId: "silent-update", requestedBy }));
      expect(updater.installed).toEqual(["fixture 0.6.0-nightly.1"]);
      expect(updater.installOptions).toEqual([{ silent: true, forceRun: true }]);
      expect(remote.snapshot().phase).toBe("restarting");
      const relaunched = new RemoteAppUpdate(path, boundary);
      await relaunched.publish();
      expect(reports.at(-1)).toMatchObject({
        requestId: "silent-update",
        phase: "succeeded",
        version: "0.6.0-nightly.1",
        targetVersion: "0.6.0-nightly.1",
        reason: "",
      });
      relaunched.stop();
    } finally {
      remote.stop();
      await server.stop(true);
    }
  });
}

test("an update needing Windows elevation reports the reason remotely without stopping services or launching NSIS", async () => {
  const { server, fixture } = await localFeeds();
  let machineInstall = true;

  const { controller, updater } = fixture(
    "0.6.0-nightly.0",
    "nightly",
    async () => false,
    () =>
      checkWindowsUpdateInstall(
        "fixture",
        false,
        () => ({ status: machineInstall ? 0 : 1 }),
        () => {},
      ),
  );

  const draining: boolean[] = [];

  const remote = new RemoteAppUpdate(join(tempDir("canopy-update-elevation-"), "remote-update.json"), {
    status: () => controller.status(),
    check: () => controller.checkRemote(),
    prepareRestart: async () => ((await controller.prepareInstall()) ? controller.status() : undefined),
    drain: async (value) => {
      draining.push(value);

      return true;
    },
    notify() {},
    report: async () => {},
    restart: () => installAppUpdate(updater, "win32"),
  });

  try {
    await remote.command(create(ui.DesktopUpdateCommandSchema, { requestId: "needs-admin" }));
    expect(remote.snapshot()).toMatchObject({ phase: "failed", reason: WINDOWS_UPDATE_ADMIN_MESSAGE });
    expect(controller.status()).toMatchObject({ phase: "downloaded", error: WINDOWS_UPDATE_ADMIN_MESSAGE });
    expect(draining).toEqual([true, false]);
    expect(updater.installed).toEqual([]);
    machineInstall = false;
    expect(await controller.prepareInstall()).toBe(true);
  } finally {
    remote.stop();
    await server.stop(true);
  }
});

test.skipIf(process.platform !== "linux")(
  "a ready update can be replaced, unchanged feeds keep it, and restart installs the latest staged bytes",
  async () => {
    const { server, fixture, publish } = await localFeeds();

    try {
      const { controller, updater } = fixture("0.6.0-nightly.0", "nightly", async () => false);
      await controller.check();
      expect(controller.status()).toMatchObject({
        phase: "downloaded",
        updateVersion: "0.6.0-nightly.1",
        stagedVersion: "0.6.0-nightly.1",
      });
      await controller.check();
      expect(updater.downloads).toHaveLength(1);
      expect(controller.status().phase).toBe("downloaded");
      await publish("nightly", "0.6.0-nightly.2");
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      updater.beforeDownload = () => {
        started.resolve();

        return finish.promise;
      };

      const checking = controller.check();
      await started.promise;
      expect(controller.status()).toMatchObject({
        phase: "downloading",
        updateVersion: "0.6.0-nightly.2",
        stagedVersion: "0.6.0-nightly.1",
      });
      let restarting = false;

      const restart = controller.prepareInstall().then((ready) => {
        if (ready) {
          updater.quitAndInstall();
          restarting = true;
        }
      });

      await Promise.resolve();
      expect(restarting).toBe(false);
      finish.resolve();
      await checking;
      await restart;
      expect(controller.status()).toMatchObject({
        phase: "downloaded",
        updateVersion: "0.6.0-nightly.2",
        stagedVersion: "0.6.0-nightly.2",
      });
      expect(updater.installed).toEqual(["fixture 0.6.0-nightly.2"]);
      await controller.checkAutomatically();
      expect(updater.downloads).toHaveLength(2);
    } finally {
      await server.stop(true);
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "a failed newer download restores the old file and restart remains available",
  async () => {
    const { server, fixture, publish } = await localFeeds();

    try {
      const { controller, updater } = fixture("0.6.0-nightly.0", "nightly", async () => false);
      await controller.check();
      await publish("nightly", "0.6.0-nightly.2");
      updater.failDownload = true;
      const failed = await controller.checkRemote();
      expect(failed).toMatchObject({
        phase: "downloaded",
        updateVersion: "0.6.0-nightly.1",
        stagedVersion: "0.6.0-nightly.1",
        error: "Update failed. Check again to retry.",
      });
      expect(await controller.prepareInstall()).toBe(true);
      updater.quitAndInstall();
      expect(updater.installed).toEqual(["fixture 0.6.0-nightly.1"]);
    } finally {
      await server.stop(true);
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "automatic checks replace ready updates and Never cancels a replacement without losing the old one",
  async () => {
    const { server, fixture, publish } = await localFeeds();

    try {
      const { controller, updater } = fixture("0.6.0-nightly.0", "nightly", async () => false);
      await controller.checkAutomatically();
      await publish("nightly", "0.6.0-nightly.2");
      await controller.checkAutomatically();
      expect(controller.status().stagedVersion).toBe("0.6.0-nightly.2");
      await publish("nightly", "0.6.0-nightly.3");
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      updater.beforeDownload = () => {
        started.resolve();

        return finish.promise;
      };

      const checking = controller.checkAutomatically();
      await started.promise;
      controller.setAutomaticUpdates(false);
      finish.resolve();
      await checking;
      expect(controller.status()).toMatchObject({ phase: "downloaded", stagedVersion: "0.6.0-nightly.2" });
      expect(await controller.prepareInstall()).toBe(true);
      updater.quitAndInstall();
      expect(updater.installed).toEqual(["fixture 0.6.0-nightly.2"]);
    } finally {
      await server.stop(true);
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "the timer checks again after downloaded and finalization failures never advertise unstaged bytes",
  async () => {
    const { server, fixture, publish } = await localFeeds();

    const timer = new UpdateCheckTimer({
      now: () => now,
      schedule: (run, wait) => {
        pending = run;
        delay = wait;

        return () => {
          pending = undefined;
        };
      },
    });

    let now = 1;
    let pending: (() => void) | undefined;
    let delay = 0;

    try {
      const { controller, updater } = fixture("0.6.0-nightly.0", "nightly", async () => false);
      await controller.check();
      await publish("nightly", "0.6.0-nightly.2");
      const checked = Promise.withResolvers<void>();
      timer.start(60, now, async () => {
        await controller.checkAutomatically();
        checked.resolve();
      });
      now += delay;
      pending?.();
      await checked.promise;
      await Promise.resolve();
      expect(controller.status().stagedVersion).toBe("0.6.0-nightly.2");
      expect(delay).toBe(60 * 60_000);
      await publish("nightly", "0.6.0-nightly.3");
      updater.failAfterDownloaded = true;
      const readyVersions: string[] = [];
      updater.on("update-downloaded", () => {
        if (controller.status().phase === "downloaded") readyVersions.push(controller.status().updateVersion ?? "");
      });
      await controller.check();
      expect(readyVersions).toEqual([]);
      expect(controller.status()).toMatchObject({
        phase: "downloaded",
        updateVersion: "0.6.0-nightly.2",
        error: "Update failed. Check again to retry.",
      });
      expect(await controller.prepareInstall()).toBe(true);
      updater.quitAndInstall();
      expect(updater.installed).toEqual(["fixture 0.6.0-nightly.2"]);
    } finally {
      timer.stop();
      await server.stop(true);
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "real generic feeds select the chosen channel without prereleases leaking to stable",
  async () => {
    const { server, fixture, requests } = await localFeeds();

    try {
      const { controller, updater, settings, phases } = fixture("0.3.0", "stable", async () => {
        throw new Error("Forward switches must not confirm");
      });

      await controller.check();
      expect(updater.downloads).toEqual([{ version: "0.4.0", downgrade: false }]);
      await controller.setChannel("beta");
      await controller.setChannel("nightly");
      expect(updater.downloads.map((item) => item.version)).toEqual(["0.4.0", "0.5.0-beta.1", "0.6.0-nightly.1"]);
      expect(updater.downloads.every((item) => !item.downgrade)).toBe(true);
      expect(settings.read("stable")).toBe("nightly");
      expect(phases).toContain("downloading");
      expect(controller.status().phase).toBe("downloaded");
      expect(controller.status().releases).toEqual([]);
      expect(requests).toEqual([
        "/v0.4.0/latest-linux.yml",
        "/v0.5.0-beta.1/beta-linux.yml",
        "/v0.6.0-nightly.1/nightly-linux.yml",
      ]);
    } finally {
      await server.stop(true);
    }
  },
);

test("release notes include every intervening channel release, newest first, without unpublished or future notes", () => {
  const releases = [
    { ...release("v0.4.0-beta.3", "beta-mac.yml"), body: "third" },
    { ...release("v0.4.0-beta.1", "beta-mac.yml"), body: "installed" },
    { ...release("v0.4.0-beta.2", "beta-mac.yml"), assets: [], body: "second" },
    { ...release("v0.4.0-beta.1.1", "beta-mac.yml"), body: null },
    { ...release("v0.4.0-beta.1.2", "beta-mac.yml"), body: "  " },
    { ...release("v0.4.0-beta.4", "beta-mac.yml"), body: "future" },
    { ...release("v0.4.0-nightly.1", "nightly-mac.yml"), body: "nightly" },
    { ...release("v0.4.0-beta.5", "beta-mac.yml"), draft: true },
  ];

  expect(releaseNotes(releases, "0.4.0-beta.1", "0.4.0-beta.3", "beta")).toEqual([
    { version: "0.4.0-beta.3", markdown: "third" },
    { version: "0.4.0-beta.2", markdown: "second" },
  ]);
});

test("an incomplete desktop publication stays visible at the updater boundary instead of claiming up to date", async () => {
  const updater = new FeedUpdater("0.2.0-nightly.32", tempDir("canopy-publishing-status-"));

  const publishing = "0.2.0-nightly.33 is not ready for macOS yet. Check again in a few minutes.";

  const controller = new UpdateController(updater, {
    recover: () => updater,
    version: "0.2.0-nightly.32",
    buildChannel: "nightly",
    channel: "nightly",
    save() {},
    confirmDowngrade: async () => false,
    prepare: async () => ({ available: false, publishing, releases: [] }),
    changed() {},
    downloaded() {},
  });

  controller.enable();
  const state = await controller.check();
  expect(state).toMatchObject({ phase: "idle", message: publishing, publishing });
  expect(updater.downloads).toHaveLength(0);
  expect(state.updateVersion).toBeUndefined();
});

test.skipIf(process.platform !== "linux")(
  "downgrade needs confirmation and expires after one switch, including a failed download",
  async () => {
    const { server, fixture } = await localFeeds();

    try {
      let accepted = false;
      const { controller, updater, settings } = fixture("0.6.0-nightly.2", "nightly", async () => accepted);
      expect((await controller.setChannel("stable")).changingChannel).toBe(false);
      expect(settings.read("nightly")).toBe("nightly");
      expect(updater.downloads).toHaveLength(0);
      accepted = true;
      await controller.setChannel("stable");
      expect(updater.downloads).toEqual([{ version: "0.4.0", downgrade: true }]);
      expect(updater.allowDowngrade).toBe(false);
      expect(updater.allowPrerelease).toBe(false);
      expect(settings.read("nightly")).toBe("stable");
      // Less stable preferences always update forward, even while the installed build is nightly.
      await controller.setChannel("beta");
      expect(updater.downloads).toHaveLength(1);
      await controller.setChannel("nightly");
      // Switching invalidates a staged download; a failure cannot reuse it or retain a grant.
      updater.failDownload = true;
      await controller.setChannel("beta");
      expect(controller.status().phase).toBe("error");
      expect(updater.allowDowngrade).toBe(false);
      const count = updater.downloads.length;
      await controller.check();
      expect(updater.downloads).toHaveLength(count);
      expect(controller.status().phase).toBe("idle");
      expect(controller.status().updateVersion).toBeUndefined();
      await expect(controller.setChannel("invalid")).rejects.toThrow("Invalid update channel");
    } finally {
      await server.stop(true);
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "confirmation serializes settings across windows and a restart keeps only the channel",
  async () => {
    const { server, fixture } = await localFeeds();

    try {
      let answer!: (accepted: boolean) => void;

      const confirmation = new Promise<boolean>((resolve) => {
        answer = resolve;
      });

      const { controller, updater, settings } = fixture("0.6.0-nightly.2", "nightly", () => confirmation);
      const switching = controller.setChannel("stable");
      const queued = controller.setChannel("beta");
      const checking = controller.checkRemote();
      expect(updater.downloads).toHaveLength(0);
      expect(settings.read("nightly")).toBe("nightly");
      answer(true);
      await switching;
      await queued;
      await checking;

      // The next launch reads a preference, never a stored downgrade authorization.
      const restored = new UpdateController(updater, {
        recover: () => updater,
        version: "0.6.0-nightly.2",
        buildChannel: "nightly",
        channel: settings.read("nightly"),
        save() {},
        confirmDowngrade: async () => false,
        prepare: async () => false,
        changed() {},
        downloaded() {},
      });

      expect(restored.status().channel).toBe("beta");
      expect(updater.allowDowngrade).toBe(false);
    } finally {
      await server.stop(true);
    }
  },
);

test("signing discovers extensionless JIT sidecars and nested native libraries without following aliases", () => {
  const directory = tempDir("canopy-desktop-macho-");
  mkdirSync(join(directory, "postgres/lib"), { recursive: true });
  mkdirSync(join(directory, "node_modules/native"), { recursive: true });
  const names = ["canopy-worker", "postgres/lib/libpq.dylib", "node_modules/native/sharp.node"];

  for (const name of names)
    writeFileSync(join(directory, name), Buffer.from("cffaedfe00000000", "hex"), { mode: 0o644 });
  writeFileSync(join(directory, "postgres/init.sql"), "select 1;");
  writeFileSync(join(directory, "icon.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  symlinkSync("postgres/lib/libpq.dylib", join(directory, "libpq-alias"));
  expect(machOFiles(directory).sort()).toEqual(names.map((name) => join(directory, name)).sort());
});

test.skipIf(process.platform !== "linux")(
  "Never blocks automatic downloads and leaves manual checks working",
  async () => {
    const { server, fixture } = await localFeeds();

    try {
      const { controller, updater } = fixture("0.3.0", "stable", async () => false);
      controller.setAutomaticUpdates(false);
      await controller.checkAutomatically();
      expect(updater.downloads).toHaveLength(0);
      await controller.check();
      expect(updater.downloads).toEqual([{ version: "0.4.0", downgrade: false }]);
    } finally {
      await server.stop(true);
    }
  },
);

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { tempDir } from "@canopy/testing";
import { newestRelease, releaseNotes, type DesktopRelease } from "../src/update-releases.ts";
import { mergeDesktopUpdates } from "../scripts/merge-update-metadata.ts";
import { AppUpdater, type DownloadUpdateOptions } from "electron-updater/out/AppUpdater.js";
import { NodeHttpExecutor } from "builder-util/out/nodeHttpExecutor.js";
import { UpdateController } from "../src/update-controller.ts";
import { UpdateSettings } from "../src/update-settings.ts";
import type { DesktopChannel } from "../src/identity.ts";
import { channelFeed } from "../src/update-releases.ts";

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
  failDownload = false;
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
  }
  protected async doDownloadUpdate(options: DownloadUpdateOptions) {
    const info = options.updateInfoAndProvider.info;
    this.downloads.push({ version: info.version, downgrade: this.allowDowngrade });

    if (this.failDownload) throw new Error("Fixture download failed");
    this.emit("download-progress", { percent: 50, total: 100, transferred: 50, delta: 50, bytesPerSecond: 50 });
    this.dispatchUpdateDownloaded({ ...info, downloadedFile: "fixture.AppImage" });

    return ["fixture.AppImage"];
  }
  quitAndInstall() {
    throw new Error("Fixtures must never install an app");
  }
}

async function localFeeds() {
  const directory = tempDir("canopy-updater-http-");
  const releases: DesktopRelease[] = [];

  for (const [channel, version] of [
    ["stable", "0.4.0"],
    ["beta", "0.5.0-beta.1"],
    ["nightly", "0.6.0-nightly.1"],
  ] as const) {
    const source = join(directory, `${channel}-source`, "desktop-linux-x64");
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
    await mergeDesktopUpdates(join(directory, `${channel}-source`), destination, channel, version);
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

  function fixture(version: string, buildChannel: DesktopChannel, confirm: () => Promise<boolean>) {
    const data = tempDir("canopy-update-settings-");
    const settings = new UpdateSettings(data);
    const updater = new FeedUpdater(version, data);
    const phases: string[] = [];

    const controller = new UpdateController(updater, {
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
    });

    controller.enable();

    return { controller, updater, settings, phases };
  }

  return { server, requests, fixture };
}

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
      expect(controller.status().releases?.map((r) => r.version)).toEqual(["0.6.0-nightly.1", "0.5.0-beta.1", "0.4.0"]);
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
    { ...release("v0.4.0-beta.4", "beta-mac.yml"), body: "future" },
    { ...release("v0.4.0-nightly.1", "nightly-mac.yml"), body: "nightly" },
    { ...release("v0.4.0-beta.5", "beta-mac.yml"), draft: true },
  ];

  expect(releaseNotes(releases, "0.4.0-beta.1", "0.4.0-beta.3", "beta")).toEqual([
    { version: "0.4.0-beta.3", markdown: "third" },
    { version: "0.4.0-beta.2", markdown: "second" },
  ]);
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
      await expect(controller.setChannel("beta")).rejects.toThrow("Wait");
      expect(() => controller.checkRemote()).toThrow("Wait");
      await controller.check();
      expect(updater.downloads).toHaveLength(0);
      expect(settings.read("nightly")).toBe("nightly");
      answer(true);
      await switching;

      // The next launch reads a preference, never a stored downgrade authorization.
      const restored = new UpdateController(updater, {
        version: "0.6.0-nightly.2",
        buildChannel: "nightly",
        channel: settings.read("nightly"),
        save() {},
        confirmDowngrade: async () => false,
        prepare: async () => false,
        changed() {},
        downloaded() {},
      });

      expect(restored.status().channel).toBe("stable");
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

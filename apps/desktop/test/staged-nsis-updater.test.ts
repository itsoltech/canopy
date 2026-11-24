import { expect, test } from "bun:test";
import { tempDir } from "@canopy/testing";
import { NodeHttpExecutor } from "builder-util/out/nodeHttpExecutor.js";
import { CancellationError, CancellationToken, CURRENT_APP_INSTALLER_FILE_NAME } from "builder-util-runtime";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { StagedNsisUpdater } from "../src/staged-nsis-updater.ts";

function blockMap(bytes: string) {
  return gzipSync(
    JSON.stringify({
      version: "2",
      files: [{ name: "file", offset: 0, checksums: [...bytes], sizes: Array.from(bytes, () => 1) }],
    }),
  );
}

function fixtureUpdater(directory: string, url: string) {
  const updater = new StagedNsisUpdater(directory, {
    version: "1.0.0",
    name: "Canopy",
    isPackaged: true,
    baseCachePath: directory,
    userDataPath: directory,
    appUpdateConfigPath: join(directory, "app-update.yml"),
    whenReady: async () => {},
    relaunch() {},
    quit() {},
    onQuit() {},
  });

  Object.assign(updater, {
    httpExecutor: new NodeHttpExecutor(),
    _testOnlyOptions: { platform: "win32", isUseDifferentialDownload: true },
  });
  updater.logger = null;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.setFeedURL({ provider: "generic", url, useMultipleRangeRequest: false });

  return updater;
}

test("NSIS applies consecutive staged deltas and keeps the previous installer after cancellation", async () => {
  const cache = tempDir("canopy-nsis-");
  const interrupted = tempDir("canopy-nsis-interrupted-");
  let snapshotTaken = false;
  const releases = ["AB", "BAC", "BCD", "ABE"];
  let target = 1;
  const ranges: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const version = `1.0.${target}`;
      const url = `Canopy-${version}.exe`;
      const bytes = releases[target]!;

      if (path === "/latest.yml") {
        const sha512 = createHash("sha512").update(bytes).digest("base64");

        return Response.json({ version, path: url, sha512, files: [{ url, size: bytes.length, sha512 }] });
      }

      if (path === "/Canopy-1.0.0.exe.blockmap") return new Response(blockMap(releases[0]!));

      if (path === "/" + url + ".blockmap") return new Response(blockMap(bytes));

      const range = request.headers.get("range");

      if (path !== "/" + url || range !== "bytes=2-2") return new Response(null, { status: 404 });
      ranges.push(range);

      if (target === 2 && !snapshotTaken) {
        // Capture the cache while the replacement still needs bytes from the network.
        cpSync(cache, interrupted, { recursive: true });
        snapshotTaken = true;
      }

      return new Response(bytes.slice(2), {
        status: 206,
        headers: { "content-range": "bytes 2-2/3", connection: "close" },
      });
    },
  });

  const updater = fixtureUpdater(cache, server.url.href);
  writeFileSync(join(cache, CURRENT_APP_INSTALLER_FILE_NAME), releases[0]!);

  try {
    await updater.checkForUpdates();
    const [first] = await updater.downloadUpdate();
    expect(readFileSync(first!, "utf8")).toBe("BAC");

    target = 2;
    await updater.checkForUpdates();
    // BaseUpdater emits this event before finishing its cache writes.
    const cancelled = new CancellationToken();
    updater.once("update-downloaded", () => cancelled.cancel());
    await expect(updater.downloadUpdate(cancelled)).rejects.toBeInstanceOf(CancellationError);
    expect(updater.manualInstaller).toBe(first!);
    expect(readFileSync(first!, "utf8")).toBe("BAC");

    const [second] = await updater.downloadUpdate();
    expect(readFileSync(second!, "utf8")).toBe("BCD");
    expect(existsSync(first!)).toBe(false);

    // A previous full download may have produced no usable staged map.
    unlinkSync(join(dirname(second!), "current.blockmap"));
    target = 3;
    await updater.checkForUpdates();
    const [third] = await updater.downloadUpdate();
    expect(readFileSync(third!, "utf8")).toBe("ABE");
    expect(existsSync(second!)).toBe(false);

    const relaunched = fixtureUpdater(interrupted, server.url.href);
    await relaunched.checkForUpdates();
    const [recovered] = await relaunched.downloadUpdate();
    expect(readFileSync(recovered!, "utf8")).toBe("ABE");
    expect(ranges).toHaveLength(5);
    expect(readFileSync(join(cache, CURRENT_APP_INSTALLER_FILE_NAME), "utf8")).toBe("AB");
  } finally {
    await server.stop(true);
  }
});

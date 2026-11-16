import { afterEach, expect, test } from "bun:test";
import { mkdtemp, open, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { RELEASE_INDEX_URL } from "@canopy/domain/release/catalog";
import { readUpdateRecord, type ReleaseManifest, type UpdateRecord } from "@canopy/updater";
import { GatewayUpdates } from "./runtime.ts";
import { gatewayUpdateMayBeStaged } from "./stage.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function cacheDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "canopy-update-runtime-"));
  directories.push(directory);

  return directory;
}

async function updateRecord(binaryPath: string, value: UpdateRecord): Promise<void> {
  const path = `${binaryPath}.${crypto.randomUUID()}.tmp`;
  const file = await open(path, "wx", 0o600);

  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }

  await rename(path, `${binaryPath}.update.json`);
}

test("a persisted latest setting is rewritten as stable and remains stable for legacy requests", async () => {
  let stored = "latest";

  const updates = new GatewayUpdates({
    kind: "source",
    version: "0.1.0",
    cacheDir: await cacheDirectory(),
    authenticate: async () => undefined,
    persistence: {
      admin: async () => true,
      channel: async () => stored,
      setChannel: async (value) => {
        stored = value;
      },
      workers: async () => [],
      hello: async () => {},
      saveCommand: async () => {},
      report: async () => {},
    },
    source: { fetch: async () => Response.json([]) },
  });

  try {
    await updates.start();
    expect(stored).toBe("stable");
    expect((await updates.snapshot()).channel).toBe("stable");
    // The gateway accepts old clients without retaining the obsolete setting.
    expect(
      (await updates.manage(create(ui.ManageUpdatesRequestSchema, { action: "channel", channel: "latest" }))).channel,
    ).toBe("stable");
    expect(stored).toBe("stable");
  } finally {
    updates.close();
  }
});

test.each(["check", "channel"])("manual %s discovers a release inside the automatic cache TTL", async (action) => {
  let published = "1.0.0";
  let indexCalls = 0;
  const manifests: string[] = [];

  const updates = new GatewayUpdates({
    kind: "source",
    version: "1.0.0",
    cacheDir: await cacheDirectory(),
    authenticate: async () => undefined,
    persistence: {
      admin: async () => true,
      channel: async () => "stable",
      setChannel: async () => {},
      workers: async () => [],
      hello: async () => {},
      saveCommand: async () => {},
      report: async () => {},
    },
    source: {
      now: () => 0,
      fetch: async (input) => {
        const url = String(input);

        if (url === RELEASE_INDEX_URL) {
          indexCalls++;

          return Response.json({
            schema: 1,
            releases: [
              {
                tag_name: `v${published}`,
                draft: false,
                prerelease: false,
                published_at: "2026-11-10T09:00:00Z",
                body: "Release notes",
                assets: [
                  { name: "manifest.json", browser_download_url: `https://example.com/${published}/manifest.json` },
                ],
              },
            ],
          });
        }

        manifests.push(url);

        return Response.json({
          schema: 1,
          version: published,
          channel: "stable",
          commit: "abcdef0",
          published_at: "2026-11-10T09:00:00Z",
          protocol: { worker_link: 1, update: 1 },
          assets: [],
        } satisfies ReleaseManifest);
      },
    },
  });

  try {
    await updates.start();
    await updates.check();
    expect((await updates.snapshot()).gatewayUpdateAvailable).toBe(false);
    published = "1.0.1";
    await updates.check();
    expect((await updates.snapshot()).availableVersion).toBe("1.0.0");
    expect(indexCalls).toBe(1);
    const snapshot = await updates.manage(create(ui.ManageUpdatesRequestSchema, { action, channel: "stable" }));
    expect(snapshot.checkError).toBe("");
    expect(snapshot.availableVersion).toBe("1.0.1");
    expect(snapshot.gatewayUpdateAvailable).toBe(true);
    expect(indexCalls).toBe(2);
    await updates.check();
    expect((await updates.snapshot()).availableVersion).toBe("1.0.1");
    expect(indexCalls).toBe(2);
    expect(manifests).toEqual(["https://example.com/1.0.0/manifest.json", "https://example.com/1.0.1/manifest.json"]);
  } finally {
    updates.close();
  }
});

test("gateway and linked checks reuse API backoff and expose a scheduled check without failing the gateway", async () => {
  let apiCalls = 0;
  const reset = Math.ceil(Date.now() / 1000) + 3600;

  const updates = new GatewayUpdates({
    kind: "source",
    version: "0.1.0",
    cacheDir: await cacheDirectory(),
    authenticate: async () => undefined,
    persistence: {
      admin: async () => true,
      channel: async () => "stable",
      setChannel: async () => {},
      workers: async () => [],
      hello: async () => {},
      saveCommand: async () => {},
      report: async () => {},
    },
    source: {
      fetch: async (input) => {
        if (!String(input).includes("api.github.com")) return new Response(null, { status: 503 });
        apiCalls++;

        return new Response(null, {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
        });
      },
    },
  });

  try {
    await updates.start();
    await updates.check();
    await Promise.all(Array.from({ length: 10 }, () => updates.check()));
    await updates.manage(create(ui.ManageUpdatesRequestSchema, { action: "check" }));
    const snapshot = await updates.snapshot();
    expect(snapshot.gatewayState).toBe("idle");
    expect(snapshot.checkError).toStartWith("GitHub is limiting update checks from this network. Next check at ");
    expect(snapshot.checking).toBe(false);
    expect(apiCalls).toBe(1);
  } finally {
    updates.close();
  }
});

test.each(["restarting", "failed"] as const)(
  "startup retention protects the durable %s update and rollback release",
  async (state) => {
    const directory = await cacheDirectory();
    const binaryPath = join(directory, "gateway");

    for (let i = 1; i <= 6; i++) {
      const manifest: ReleaseManifest = {
        schema: 1,
        version: `1.0.${i}`,
        channel: "stable",
        commit: "abcdef0",
        published_at: "2026-11-03T00:00:00Z",
        protocol: { worker_link: 1, update: 1 },
        assets: [
          {
            app: "worker",
            os: "linux",
            arch: "x64",
            name: "canopy-worker-linux-x64",
            url: "https://example.com/worker",
            sha256: String(i).padStart(64, "0"),
            size: 1,
          },
        ],
      };

      const path = join(directory, `manifest-${manifest.version}.json`);
      await writeFile(path, JSON.stringify(manifest));
      await utimes(path, i, i);
      await writeFile(join(directory, manifest.assets[0]!.sha256), String(i));
    }

    await updateRecord(binaryPath, {
      commandId: "update-1",
      previousVersion: "1.0.1",
      version: "1.0.2",
      state,
      reason: "",
    });

    const updates = new GatewayUpdates({
      kind: "binary",
      version: state === "restarting" ? "1.0.2" : "1.0.1",
      binaryPath,
      cacheDir: directory,
      authenticate: async () => undefined,
      persistence: {
        admin: async () => true,
        channel: async () => "stable",
        setChannel: async () => {},
        workers: async () => [],
        hello: async () => {},
        saveCommand: async () => {},
        report: async () => {},
      },
      source: { fetch: async () => Response.json([]) },
    });

    try {
      await updates.start();
      expect((await readdir(directory)).filter((name) => name.startsWith("manifest-")).sort()).toEqual([
        "manifest-1.0.1.json",
        "manifest-1.0.2.json",
        "manifest-1.0.6.json",
      ]);
      expect(await Bun.file(join(directory, "1".padStart(64, "0"))).exists()).toBe(true);
      expect(await Bun.file(join(directory, "2".padStart(64, "0"))).exists()).toBe(true);
      expect((await readUpdateRecord(binaryPath))?.state).toBe(state === "restarting" ? "succeeded" : "failed");
    } finally {
      updates.close();
    }
  },
);

test("a failed stage releases its pin only when a durable pending update can be ruled out", async () => {
  const directory = await cacheDirectory();
  const binaryPath = join(directory, "gateway");
  expect(await gatewayUpdateMayBeStaged(binaryPath, "1.0.2")).toBe(false);
  await updateRecord(binaryPath, {
    commandId: "update-1",
    previousVersion: "1.0.1",
    version: "1.0.2",
    state: "restarting",
    reason: "",
  });
  expect(await gatewayUpdateMayBeStaged(binaryPath, "1.0.2")).toBe(true);
  expect(await gatewayUpdateMayBeStaged(binaryPath, "1.0.3")).toBe(false);
  await writeFile(`${binaryPath}.update.json`, "{");
  expect(await gatewayUpdateMayBeStaged(binaryPath, "1.0.2")).toBe(true);
});

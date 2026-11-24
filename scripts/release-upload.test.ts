import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { writeReleaseFiles } from "./release-manifest.ts";
import { requireBetaPublication, requireNightlyPublication, requireStableBeta } from "./release-publication.ts";
import {
  uploadRelease,
  type Release,
  type ReleaseUploadAdapters,
  type ReleaseUploadOptions,
  type UploadedAsset,
} from "./release-upload.ts";
import { channelFeed, newestRelease, type DesktopRelease } from "../apps/desktop/src/update-releases.ts";
import type { DesktopChannel } from "../apps/desktop/src/identity.ts";

const directories: string[] = [];

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(
  channel: DesktopChannel = "nightly",
  existing = true,
  requireStableBeta: ReleaseUploadAdapters["requireStableBeta"] = () => {},
  version = channel === "stable" ? "0.2.0" : `0.2.0-${channel}.1`,
) {
  const directory = mkdtempSync(join(tmpdir(), "canopy-release-upload-unit-"));
  directories.push(directory);

  const options: ReleaseUploadOptions = {
    repo: "itsoltech/canopy",
    tag: `v${version}`,
    version,
    channel,
    sha: "abc123456789",
    publish: false,
    macIntel: true,
  };

  const release: Release = { id: 1, tag_name: options.tag, draft: true, prerelease: channel !== "stable" };
  let present = existing;
  const uploaded = new Map<string, UploadedAsset>();
  const observed: (string | undefined)[] = [];
  const feed = `${channelFeed(channel)}-mac.yml`;

  const previous: DesktopRelease = {
    tag_name: channel === "stable" ? "v0.1.0" : `v0.1.0-${channel}.1`,
    draft: false,
    prerelease: channel !== "stable",
    assets: [{ name: feed }, { name: "manifest.json" }],
  };

  let nextAssetId = 1;
  let interruptUpload = false;
  let lostPublishResponse = false;
  let corrupt: ((assets: UploadedAsset[]) => UploadedAsset[]) | undefined;

  const observe = () => {
    const selected = newestRelease([{ ...release, assets: [...uploaded.values()] }, previous], "0.0.0", channel, feed);

    observed.push(selected?.tag_name);
  };

  const local = (name: string): Omit<UploadedAsset, "id"> => {
    const bytes = readFileSync(join(directory, name));

    return {
      name,
      size: bytes.length,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      state: "uploaded",
    };
  };

  const adapters: ReleaseUploadAdapters = {
    find: () => {
      observe();

      return present ? { ...release } : undefined;
    },
    create: () => {
      present = true;
      observe();
    },
    assets: () => {
      observe();
      const assets = [...uploaded.values()];

      return corrupt ? corrupt(assets) : assets;
    },
    deleteAsset: (_repo, id) => {
      if (!release.draft) throw new Error("Cannot mutate published assets");

      for (const [name, asset] of uploaded) {
        if (asset.id === id) uploaded.delete(name);
      }
    },
    upload: (_repo, _tag, paths) => {
      if (!release.draft) throw new Error("Cannot mutate published assets");

      for (const path of paths) {
        const name = basename(path);
        uploaded.set(name, { id: nextAssetId++, ...local(name) });
        observe();

        if (interruptUpload) {
          interruptUpload = false;
          throw new Error("Upload interrupted after write");
        }
      }
    },
    requireStableBeta,
    requireBetaPublication: () => {},
    requireNightlyPublication: () => {},
    publish: (_repo, _id, stable) => {
      expect(stable).toBe(channel === "stable");

      for (const name of readdirSync(directory)) expect(uploaded.get(name)).toMatchObject(local(name));
      release.draft = false;
      observe();

      if (lostPublishResponse) throw new Error("Publish response lost");
    },
  };

  const env = {
    CANOPY_VERSION: version,
    CANOPY_RELEASE_TAG: options.tag,
    CANOPY_CHANNEL: channel,
    GITHUB_SHA: options.sha,
  };

  const write = (name: string) => writeFileSync(join(directory, name), `bytes for ${name}`);

  for (const target of ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64", "windows-x64"])
    for (const app of ["gateway", "worker"])
      write(`canopy-${app}-${target}${target.startsWith("windows") ? ".exe" : ""}`);

  const desktop = (arm = false) => {
    const installers = [
      "linux-x64.AppImage",
      "linux-x64.deb",
      "darwin-arm64.dmg",
      "darwin-arm64.zip",
      "darwin-arm64.dmg.blockmap",
      "darwin-arm64.zip.blockmap",
      "darwin-x64.dmg",
      "darwin-x64.zip",
      "darwin-x64.dmg.blockmap",
      "darwin-x64.zip.blockmap",
      "windows-x64.exe",
      "windows-x64.exe.blockmap",
    ];

    if (arm) installers.push("linux-arm64.AppImage", "linux-arm64.deb");

    for (const name of installers) write(`Canopy-${version}-${name}`);

    const channels = channel === "stable" ? ["latest", "beta"] : [channel];

    for (const feed of channels)
      for (const suffix of ["", "-mac", "-linux", ...(arm ? ["-linux-arm64"] : [])]) write(`${feed}${suffix}.yml`);
  };

  return {
    directory,
    previous,
    options,
    release,
    uploaded,
    observed,
    adapters,
    desktop,
    generate: () => writeReleaseFiles(directory, env),
    stage: () => uploadRelease(directory, options, adapters),
    publish: () => uploadRelease(directory, { ...options, publish: true }, adapters),
    interrupt: () => {
      interruptUpload = true;
    },
    loseResponse: () => {
      lostPublishResponse = true;
    },
    corrupt: (change: (assets: UploadedAsset[]) => UploadedAsset[]) => {
      corrupt = change;
    },
  };
}

for (const channel of ["nightly", "beta", "stable"] as const) {
  test(`${channel}: old release stays selected until every asset and feed is verified`, async () => {
    const f = fixture(channel, false);
    await f.generate();
    await f.stage();
    expect(f.release.draft).toBe(true);
    expect(new Set(f.observed)).toEqual(new Set([f.previous.tag_name]));
    await expect(f.publish()).rejects.toThrow("Release is incomplete");
    f.desktop(channel !== "nightly");
    await f.generate();
    await f.publish();
    expect(f.release.draft).toBe(false);
    expect(f.observed.at(-1)).toBe(f.options.tag);
    expect(new Set(f.observed.slice(0, -1))).toEqual(new Set([f.previous.tag_name]));
  });
}

test("a resumed stable draft drops nightly feed aliases before it becomes visible", async () => {
  const f = fixture("stable");
  f.desktop();
  f.uploaded.set("nightly-mac.yml", {
    id: 0,
    name: "nightly-mac.yml",
    size: 123,
    state: "uploaded",
    digest: null,
  });
  await f.generate();
  await f.publish();
  expect(f.release.draft).toBe(false);
  expect(f.uploaded.has("nightly-mac.yml")).toBe(false);
});

test("stable can publish after the next nightly series opens and requires the tested beta SHA", async () => {
  const releases = [
    { tag_name: "v0.5.0", draft: false, prerelease: false },
    { tag_name: "v0.6.0-beta.1", draft: false, prerelease: true },
    { tag_name: "v0.7.0-nightly.4", draft: false, prerelease: true },
  ];

  const f = fixture("stable", true, undefined, "0.6.0");
  let betaSha = "first-beta-sha";

  f.adapters.requireStableBeta = (repo, tag, sha) => {
    expect(f.uploaded.has("manifest.json")).toBe(true);
    requireStableBeta(repo, tag, sha, {
      pages: () => releases,
      git: (...args) => {
        expect(args.at(-1)).toContain("refs/tags/v0.6.0-beta.1");

        return betaSha;
      },
    });
  };

  f.desktop();
  await f.generate();
  await expect(f.publish()).rejects.toThrow("must match v0.6.0-beta.1");
  expect(f.release.draft).toBe(true);
  expect(new Set(f.observed)).toEqual(new Set([f.previous.tag_name]));

  betaSha = f.options.sha;
  await f.publish();
  expect(f.release.draft).toBe(false);
});

test("a reserved 0.5.0-nightly.5 stays hidden when stable 0.5.0 publishes during its build", async () => {
  const old = fixture("nightly", true, undefined, "0.5.0-nightly.5");
  const next = fixture("nightly", true, undefined, "0.6.0-nightly.1");
  const stable = { tag_name: "v0.5.0", draft: true, prerelease: false };
  const gitCalls: string[][] = [];

  const adapters = {
    pages: () => [stable, { tag_name: "v0.5.0-nightly.4", draft: false, prerelease: true }],
    git: (...args: string[]) => {
      gitCalls.push(args);

      return "";
    },
  };

  for (const candidate of [old, next])
    candidate.adapters.requireNightlyPublication = (repo, tag, sha) =>
      requireNightlyPublication(repo, tag, sha, adapters);

  await old.generate();
  await old.stage();
  old.desktop();
  await old.generate();
  stable.draft = false;
  await expect(old.publish()).rejects.toThrow("nightly requires 0.6.0-nightly.1 or later");
  expect(old.release.draft).toBe(true);
  expect(old.uploaded.get("manifest.json")?.state).toBe("uploaded");
  expect(gitCalls).toEqual([]);

  next.desktop();
  await next.generate();
  await next.publish();
  expect(next.release.draft).toBe(false);
  expect(gitCalls).toContainEqual(["rev-parse", "refs/tags/v0.5.0^{commit}"]);
});

test("a public beta closes its nightly series before stable and the active beta stays on its minor line", () => {
  const releases = [
    { tag_name: "v0.5.0", draft: false, prerelease: false },
    { tag_name: "v0.6.0-beta.1", draft: false, prerelease: true },
  ];

  let mainTags = "v0.5.0";

  const adapters = {
    pages: () => releases,
    git: (...args: string[]) => (args.includes("--points-at") ? mainTags : "v0.5.0\nv0.6.0-beta.1"),
  };

  expect(() => requireNightlyPublication("fixture/canopy", "v0.6.0-nightly.5", "sha", adapters)).toThrow(
    "nightly requires 0.7.0-nightly.1 or later",
  );
  requireNightlyPublication("fixture/canopy", "v0.7.0-nightly.1", "sha", adapters);
  requireBetaPublication("fixture/canopy", "v0.6.0-beta.2", adapters);
  expect(() => requireBetaPublication("fixture/canopy", "v0.7.0-beta.1", adapters)).toThrow("active beta line");

  mainTags = "v0.6.0-beta.1";
  expect(() => requireBetaPublication("fixture/canopy", "v0.6.0-beta.2", adapters)).toThrow("next patch version");
  requireBetaPublication("fixture/canopy", "v0.6.1-beta.1", adapters);

  releases.push({ tag_name: "v0.6.0", draft: false, prerelease: false });
  requireBetaPublication("fixture/canopy", "v0.7.0-beta.1", adapters);
  releases.push({ tag_name: "v0.7.0-beta.1", draft: false, prerelease: true });
  expect(() => requireNightlyPublication("fixture/canopy", "v0.7.0-nightly.5", "sha", adapters)).toThrow(
    "nightly requires 0.8.0-nightly.1 or later",
  );
});

test("interrupted uploads resume the draft; a lost publish response never clobbers public files", async () => {
  const f = fixture();
  f.desktop();
  await f.generate();
  f.interrupt();
  await expect(f.publish()).rejects.toThrow("Upload interrupted");
  expect(f.release.draft).toBe(true);
  expect(f.uploaded.size).toBeGreaterThan(0);
  f.loseResponse();
  await expect(f.publish()).rejects.toThrow("Publish response lost");
  expect(f.release.draft).toBe(false);
  const published = [...f.uploaded.values()];
  await f.generate();
  await f.stage();
  await f.publish();
  expect([...f.uploaded.values()]).toEqual(published);
});

for (const problem of ["missing", "state", "size", "digest"]) {
  test(`verification refuses publication when an uploaded asset has invalid ${problem}`, async () => {
    const f = fixture();
    f.desktop();
    await f.generate();
    f.corrupt((assets) =>
      assets.flatMap((asset) => {
        if (asset.name !== "nightly-mac.yml") return [asset];

        if (problem === "missing") return [];

        return [
          {
            ...asset,
            ...(problem === "state"
              ? { state: "starter" }
              : problem === "size"
                ? { size: 0 }
                : { digest: "sha256:wrong" }),
          },
        ];
      }),
    );
    await expect(f.publish()).rejects.toThrow("Uploaded asset failed verification: nightly-mac.yml");
    expect(f.release.draft).toBe(true);
    expect(new Set(f.observed)).toEqual(new Set([f.previous.tag_name]));
  });
}

test("missing Windows/macOS/Linux feeds, blockmaps and experimental feeds keep the draft hidden", async () => {
  for (const missing of [
    "latest.yml",
    "beta-mac.yml",
    "latest-linux.yml",
    "latest-linux-arm64.yml",
    "Canopy-0.2.0-windows-x64.exe.blockmap",
    "Canopy-0.2.0-darwin-arm64.zip",
    "Canopy-0.2.0-darwin-x64.zip",
    "Canopy-0.2.0-darwin-x64.dmg",
    "Canopy-0.2.0-darwin-x64.zip.blockmap",
    "Canopy-0.2.0-darwin-x64.dmg.blockmap",
    "canopy-worker-darwin-x64",
    "canopy-gateway-darwin-x64",
  ]) {
    const f = fixture("stable");
    f.desktop(true);
    rmSync(join(f.directory, missing));
    await f.generate();
    await expect(f.publish()).rejects.toThrow(missing);
    expect(f.release.draft).toBe(true);
    expect(f.uploaded.size).toBe(0);
  }
});

test("recovery publishes a revision that only supported Apple Silicon on macOS", async () => {
  const f = fixture("stable");
  f.options.macIntel = false;
  f.desktop();

  for (const name of readdirSync(f.directory)) {
    if (name.includes("darwin-x64")) rmSync(join(f.directory, name));
  }

  await f.generate();
  await f.publish();
  expect(f.release.draft).toBe(false);
});

test("GitHub read failures abort without treating an unknown release as absent", async () => {
  const f = fixture();
  await f.generate();
  await expect(
    uploadRelease(f.directory, f.options, {
      ...f.adapters,
      find: () => {
        throw new Error("HTTP 502");
      },
    }),
  ).rejects.toThrow("HTTP 502");
  expect(f.uploaded.size).toBe(0);
  expect(f.release.draft).toBe(true);
});

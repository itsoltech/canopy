import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { writeReleaseFiles } from "./release-manifest.ts";
import {
  uploadRelease,
  type Release,
  type ReleaseUploadAdapters,
  type ReleaseUploadOptions,
  type UploadedAsset,
} from "./release-upload.ts";
import { newestRelease } from "../apps/desktop/src/update-releases.ts";

const directories: string[] = [];

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(channel = "nightly", existing = true) {
  const directory = mkdtempSync(join(tmpdir(), "canopy-release-upload-unit-"));
  directories.push(directory);
  const version = channel === "stable" ? "0.2.0" : `0.2.0-${channel}.1`;

  const options: ReleaseUploadOptions = {
    repo: "itsoltech/canopy",
    tag: `v${version}`,
    version,
    channel,
    sha: "abc123456789",
    publish: false,
  };

  const release: Release = { id: 1, tag_name: options.tag, draft: true, prerelease: channel !== "stable" };
  let present = existing;
  const uploaded = new Map<string, UploadedAsset>();
  const observed: (string | undefined)[] = [];
  let interruptUpload = false;
  let lostPublishResponse = false;
  let corrupt: ((assets: UploadedAsset[]) => UploadedAsset[]) | undefined;

  const observe = () => {
    const selected = newestRelease(
      [
        { ...release, assets: [...uploaded.values()] },
        {
          tag_name: "v0.1.0",
          draft: false,
          prerelease: false,
          assets: [{ name: "nightly-mac.yml" }, { name: "manifest.json" }],
        },
      ],
      "0.0.0",
      "nightly",
      "nightly-mac.yml",
    );

    observed.push(selected?.tag_name);
  };

  const local = (name: string): UploadedAsset => {
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
    upload: (_repo, _tag, paths) => {
      if (!release.draft) throw new Error("Cannot mutate published assets");

      for (const path of paths) {
        const name = basename(path);
        uploaded.set(name, local(name));
        observe();

        if (interruptUpload) {
          interruptUpload = false;
          throw new Error("Upload interrupted after write");
        }
      }
    },
    publish: (_repo, _id, stable) => {
      expect(stable).toBe(channel === "stable");

      for (const name of readdirSync(directory)) expect(uploaded.get(name)).toEqual(local(name));
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

  for (const target of ["linux-x64", "linux-arm64", "darwin-arm64", "windows-x64"])
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
      "windows-x64.exe",
      "windows-x64.exe.blockmap",
    ];

    if (arm) installers.push("linux-arm64.AppImage", "linux-arm64.deb");

    for (const name of installers) write(`Canopy-${version}-${name}`);

    const channels =
      channel === "stable" ? ["latest", "beta", "nightly"] : channel === "beta" ? ["beta", "nightly"] : ["nightly"];

    for (const feed of channels)
      for (const suffix of ["", "-mac", "-linux", ...(arm ? ["-linux-arm64"] : [])]) write(`${feed}${suffix}.yml`);
  };

  return {
    directory,
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

for (const channel of ["nightly", "beta", "stable"]) {
  test(`${channel}: old release stays selected until every asset and cumulative feed is verified`, async () => {
    const f = fixture(channel, false);
    await f.generate();
    await f.stage();
    expect(f.release.draft).toBe(true);
    expect(new Set(f.observed)).toEqual(new Set(["v0.1.0"]));
    await expect(f.publish()).rejects.toThrow("Release is incomplete");
    f.desktop(channel !== "nightly");
    await f.generate();
    await f.publish();
    expect(f.release.draft).toBe(false);
    expect(f.observed.at(-1)).toBe(f.options.tag);
    expect(new Set(f.observed.slice(0, -1))).toEqual(new Set(["v0.1.0"]));
  });
}

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
    expect(new Set(f.observed)).toEqual(new Set(["v0.1.0"]));
  });
}

test("missing Windows/macOS/Linux aliases, blockmaps and experimental feeds keep the draft hidden", async () => {
  for (const missing of [
    "nightly.yml",
    "beta-mac.yml",
    "latest-linux.yml",
    "nightly-linux-arm64.yml",
    "Canopy-0.2.0-windows-x64.exe.blockmap",
    "Canopy-0.2.0-darwin-arm64.zip",
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

/** Behavioral dry-runs of the real config against a throwaway local clone; no GitHub or app services. */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveVersion } from "./version.ts";
import { releaseManifest, writeReleaseFiles } from "./release-manifest.ts";
import { mergeDesktopUpdates } from "../apps/desktop/scripts/merge-update-metadata.ts";
import { newestRelease } from "../apps/desktop/src/update-releases.ts";

const root = resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "canopy-release-unit-"));
  temporaryDirectories.push(dir);

  const remote = join(dir, "origin.git"),
    cwd = join(dir, "checkout");

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "pipe" });
  execFileSync("git", ["clone", remote, cwd], { stdio: "pipe" });
  git("remote", "set-url", "origin", pathToFileURL(remote).href);
  git("config", "user.name", "Release fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "core.hooksPath", "/dev/null");
  git("config", "tag.gpgSign", "false");
  git("config", "tag.forceSignAnnotated", "false");
  git("config", "commit.gpgSign", "false");
  mkdirSync(join(cwd, "scripts"));
  copyFileSync(join(root, "release.config.mjs"), join(cwd, "canopy.config.mjs"));
  copyFileSync(join(root, "scripts/release-analyzer.mjs"), join(cwd, "scripts/release-analyzer.mjs"));
  copyFileSync(join(root, "scripts/release-expected-version.mjs"), join(cwd, "scripts/release-expected-version.mjs"));
  writeFileSync(
    join(cwd, "release.config.mjs"),
    'import config from "./canopy.config.mjs"; export default { ...config, plugins: config.plugins.filter((plugin) => !(Array.isArray(plugin) && plugin[0] === "@semantic-release/github")) };\n',
  );
  writeFileSync(join(cwd, ".gitignore"), "node_modules/\n");
  symlinkSync(join(root, "node_modules"), join(cwd, "node_modules"), "dir");
  git("add", ".");
  git("commit", "-m", "chore: bootstrap fixture");
  git("tag", "v0.1.0");
  git("branch", "next");
  git("branch", "dev");
  git("push", "origin", "main", "next", "dev", "--tags");

  async function run(dry = true, expectedVersion = ""): Promise<string> {
    const result = Bun.spawn(["bunx", "--no-install", "semantic-release", ...(dry ? ["--dry-run"] : []), "--no-ci"], {
      cwd,
      env: {
        ...process.env,
        GITHUB_TOKEN: "",
        GH_TOKEN: "",
        GITHUB_ACTIONS: "",
        GITHUB_REF: "",
        GITHUB_SHA: "",
        CI: "",
        EXPECTED_VERSION: expectedVersion,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(result.stdout).text(),
      new Response(result.stderr).text(),
      result.exited,
    ]);

    const output = stdout + stderr;

    if (code !== 0) throw new Error(output);

    return output;
  }

  const remoteTags = () =>
    execFileSync("git", ["tag", "--list"], { cwd: remote, encoding: "utf8" }).trim().split("\n").sort();

  return {
    git,
    remoteTags,
    dryRun: () => run(),
    publishLocally: (expectedVersion?: string) => run(false, expectedVersion),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("bootstrap branches produce no release, then feat produces stable, beta and nightly 0.2.0", async () => {
  const repo = fixture();

  try {
    for (const [branch, version] of [
      ["main", "0.2.0"],
      ["next", "0.2.0-beta.1"],
      ["dev", "0.2.0-nightly.1"],
    ]) {
      repo.git("checkout", branch!);
      expect(await repo.dryRun()).toContain("no new version is released");
      repo.git("commit", "--allow-empty", "-m", "feat: add release fixture feature");
      repo.git("push", "origin", branch!);
      expect(await repo.dryRun()).toContain(`Published release ${version} on`);
    }
  } finally {
    repo.cleanup();
  }
}, 60_000);

test("BREAKING CHANGE bumps minor while 0.x, and major after 1.0.0", async () => {
  const repo = fixture();

  try {
    repo.git("commit", "--allow-empty", "-m", "feat: change contract\n\nBREAKING CHANGE: require the new contract");
    repo.git("push", "origin", "main");
    expect(await repo.dryRun()).toContain("Published release 0.2.0 on");
    repo.git("tag", "v1.0.0");
    repo.git("commit", "--allow-empty", "-m", "feat: replace contract\n\nBREAKING CHANGE: remove the old contract");
    repo.git("push", "origin", "main", "--tags");
    expect(await repo.dryRun()).toContain("Published release 2.0.0 on");
  } finally {
    repo.cleanup();
  }
}, 60_000);

test("release versions assign Docker aliases exclusively to their channel", () => {
  const commit = "abc123456789";
  expect(resolveVersion({ commit, tag: "v0.1.0" }).dockerTags).toEqual(["v0.1.0", "v0.1", "v0", "latest", "stable"]);
  expect(resolveVersion({ commit, tag: "v0.2.0-beta.1" }).dockerTags).toEqual(["v0.2.0-beta.1", "beta"]);
  expect(resolveVersion({ commit, tag: "v0.2.0-nightly.1" }).dockerTags).toEqual(["v0.2.0-nightly.1", "nightly"]);
  expect(resolveVersion({ commit }).dockerTags).toEqual([]);
});

test("manifest preserves the exact version/channel and rejects contradictory release metadata", async () => {
  const directory = mkdtempSync(join(tmpdir(), "canopy-release-manifest-unit-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, "canopy-worker-linux-x64"), "fixture binary");

  const env = {
    GITHUB_SHA: "abc123456789",
    CANOPY_VERSION: "0.2.0-beta.1",
    CANOPY_RELEASE_TAG: "v0.2.0-beta.1",
    CANOPY_CHANNEL: "beta",
  };

  const manifest = await releaseManifest(directory, env);
  expect(manifest.version).toBe("0.2.0-beta.1");
  expect(manifest.channel).toBe("beta");
  expect(manifest.assets[0]?.url).toContain("/v0.2.0-beta.1/canopy-worker-linux-x64");
  writeFileSync(join(directory, "beta-mac.yml"), "desktop feed");
  writeFileSync(join(directory, "Canopy-0.2.0-beta.1-darwin-arm64.zip.blockmap"), "desktop blockmap");
  expect((await releaseManifest(directory, env)).assets).toEqual(manifest.assets);
  writeFileSync(join(directory, "nightly-mac.yml"), "cumulative alias");
  expect((await releaseManifest(directory, env)).assets).toEqual(manifest.assets);
  writeFileSync(join(directory, "latest-mac.yml"), "wrong channel");
  await expect(releaseManifest(directory, env)).rejects.toThrow("Not a release asset");
  await expect(releaseManifest(directory, { ...env, CANOPY_CHANNEL: "stable" })).rejects.toThrow("must match");
});

test.each([
  { channel: "stable", version: "0.2.0", feeds: ["latest", "beta", "nightly"] },
  { channel: "beta", version: "0.2.0-beta.1", feeds: ["beta", "nightly"] },
  { channel: "nightly", version: "0.2.0-nightly.1", feeds: ["nightly"] },
] as const)(
  "Windows $channel publication preserves installer, feeds, blockmap and updater eligibility",
  async ({ channel, version, feeds }) => {
    const directory = mkdtempSync(join(tmpdir(), "canopy-release-windows-unit-"));
    temporaryDirectories.push(directory);
    const artifact = join(directory, "artifacts/desktop-windows-x64");
    const assets = join(directory, "assets");
    mkdirSync(artifact, { recursive: true });
    const name = `Canopy-${version}-windows-x64.exe`;
    const installer = Buffer.from(`Windows installer ${version}`);
    const sha512 = createHash("sha512").update(installer).digest("base64");
    writeFileSync(join(artifact, name), installer);
    writeFileSync(join(artifact, `${name}.blockmap`), "Windows installer blockmap");
    writeFileSync(
      join(artifact, `${feeds[0]}.yml`),
      JSON.stringify({ version, files: [{ url: name, sha512, size: installer.length }], path: name, sha512 }),
    );

    await mergeDesktopUpdates(join(directory, "artifacts"), assets, channel, version);

    const manifest = await writeReleaseFiles(assets, {
      CANOPY_VERSION: version,
      CANOPY_CHANNEL: channel,
      CANOPY_RELEASE_TAG: `v${version}`,
      GITHUB_SHA: "abc123456789",
    });

    expect(manifest.assets).toEqual([expect.objectContaining({ app: "desktop", os: "windows", arch: "x64", name })]);
    expect(readFileSync(join(assets, name))).toEqual(installer);

    const checksums = readFileSync(join(assets, "checksums.txt"), "utf8");

    for (const file of [name, `${name}.blockmap`, ...feeds.map((feed) => `${feed}.yml`)]) {
      const contents = readFileSync(join(assets, file));
      expect(checksums).toContain(`${createHash("sha256").update(contents).digest("hex")}  ${file}\n`);
    }

    for (const feed of feeds) {
      expect(readFileSync(join(assets, `${feed}.yml`), "utf8")).toContain(sha512);
      expect(
        newestRelease(
          [
            {
              tag_name: `v${version}`,
              draft: false,
              prerelease: channel !== "stable",
              assets: readdirSync(assets).map((name) => ({ name })),
            },
          ],
          "0.1.0",
          feed === "latest" ? "stable" : feed,
          `${feed}.yml`,
        )?.tag_name,
      ).toBe(`v${version}`);
    }
  },
);

test("fast-forward promotions retain the base version, and docs-only changes produce no release", async () => {
  const repo = fixture();

  try {
    repo.git("checkout", "dev");
    repo.git("commit", "--allow-empty", "-m", "feat: add a promoted feature");
    repo.git("push", "origin", "dev");
    expect(await repo.publishLocally()).toContain("Published release 0.2.0-nightly.1 on nightly");
    repo.git("checkout", "next");
    repo.git("merge", "--ff-only", "dev");
    repo.git("push", "origin", "next");
    expect(await repo.publishLocally()).toContain("Published release 0.2.0-beta.1 on beta");
    repo.git("checkout", "main");
    repo.git("merge", "--ff-only", "next");
    repo.git("push", "origin", "main");
    expect(await repo.publishLocally()).toContain("Published release 0.2.0 on default");
    repo.git("commit", "--allow-empty", "-m", "docs: explain promotion");
    repo.git("push", "origin", "main");
    expect(await repo.dryRun()).toContain("no new version is released");
  } finally {
    repo.cleanup();
  }
}, 60_000);

test("a release publishes only the planned version, and a superseded run publishes nothing", async () => {
  const repo = fixture();

  try {
    repo.git("checkout", "dev");
    repo.git("commit", "--allow-empty", "-m", "feat: first merge");
    repo.git("push", "origin", "dev");
    // Run A plans while its checks run; run B's merge lands before A's checks finish and plans the same version.
    expect(await repo.dryRun()).toContain("Published release 0.2.0-nightly.1 on");
    repo.git("commit", "--allow-empty", "-m", "fix: second merge");
    repo.git("push", "origin", "dev");
    expect(await repo.dryRun()).toContain("Published release 0.2.0-nightly.1 on");
    // Run A's real release: its commit is behind the branch, so nothing is tagged.
    const runB = repo.git("rev-parse", "HEAD");
    repo.git("reset", "--hard", "HEAD~1");
    expect(await repo.publishLocally("0.2.0-nightly.1")).toContain("is behind the remote one");
    expect(repo.remoteTags()).toEqual(["v0.1.0"]);
    // Run B: a different version than planned is refused before tagging; the planned one is published.
    repo.git("reset", "--hard", runB);
    await expect(repo.publishLocally("0.2.0-nightly.2")).rejects.toThrow(
      "Planned 0.2.0-nightly.2 but the release would be 0.2.0-nightly.1",
    );
    expect(repo.remoteTags()).toEqual(["v0.1.0"]);
    expect(await repo.publishLocally("0.2.0-nightly.1")).toContain("Published release 0.2.0-nightly.1 on nightly");
    expect(repo.remoteTags()).toEqual(["v0.1.0", "v0.2.0-nightly.1"]);
  } finally {
    repo.cleanup();
  }
}, 60_000);

test("server-then-desktop publication keeps checksums.txt and manifest.json consistent and repeatable", async () => {
  const base = mkdtempSync(join(tmpdir(), "canopy-release-stages-unit-"));
  temporaryDirectories.push(base);

  const assets = join(base, "release-assets"),
    artifacts = join(base, "desktop-artifacts");

  const version = "0.2.0-nightly.3";

  const env = {
    GITHUB_SHA: "abc123456789",
    GITHUB_REPOSITORY: "itsoltech/canopy",
    CANOPY_VERSION: version,
    CANOPY_RELEASE_TAG: `v${version}`,
    CANOPY_CHANNEL: "nightly",
  };

  mkdirSync(assets);

  for (const name of ["canopy-gateway-linux-x64", "canopy-worker-linux-x64", "canopy-worker-windows-x64.exe"])
    writeFileSync(join(assets, name), `binary ${name}`);
  const sha256 = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

  const consistent = (manifest: Awaited<ReturnType<typeof writeReleaseFiles>>) => {
    const files = readdirSync(assets)
      .filter((name) => name !== "checksums.txt" && name !== "manifest.json")
      .sort();

    const checksums = readFileSync(join(assets, "checksums.txt"), "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("  "));

    expect(checksums.map(([, name]) => name)).toEqual(files);

    for (const [hash, name] of checksums) expect(hash).toBe(sha256(join(assets, name!)));
    expect(JSON.parse(readFileSync(join(assets, "manifest.json"), "utf8"))).toEqual(manifest);

    for (const asset of manifest.assets) {
      expect(files).toContain(asset.name);
      expect(asset.sha256).toBe(sha256(join(assets, asset.name)));
      expect(asset.url).toBe(`https://github.com/itsoltech/canopy/releases/download/v${version}/${asset.name}`);
    }
  };

  // Stage 1: server assets only.
  const server = await writeReleaseFiles(assets, env);
  consistent(server);
  expect(server.assets.map((asset) => asset.app)).toEqual(["gateway", "worker", "worker"]);
  // Stage 2: one desktop target finished (the other failed); feeds are merged next to the binaries.
  const linux = join(artifacts, "desktop-linux-x64");
  mkdirSync(linux, { recursive: true });
  const installer = `Canopy-${version}-linux-x64.AppImage`;
  writeFileSync(join(linux, installer), "appimage");
  writeFileSync(join(linux, `${installer}.blockmap`), "blockmap");
  const sha512 = new Bun.CryptoHasher("sha512").update("appimage").digest("base64");
  writeFileSync(
    join(linux, "nightly-linux.yml"),
    `version: ${version}\nfiles:\n  - url: ${installer}\n    sha512: ${sha512}\n    size: 8\npath: ${installer}\nsha512: ${sha512}\n`,
  );
  // download-artifact v5 flattens its output when only one target succeeds.
  await mergeDesktopUpdates(linux, assets, "nightly", version);
  const desktop = await writeReleaseFiles(assets, env);
  consistent(desktop);
  expect(desktop.assets.filter((asset) => asset.app !== "desktop")).toEqual([...server.assets]);
  expect(desktop.assets.filter((asset) => asset.app === "desktop").map((asset) => asset.name)).toEqual([installer]);
  expect(readFileSync(join(assets, "checksums.txt"), "utf8")).toContain("  nightly-linux.yml\n");
  // "Re-run failed jobs" adds the missing target: the same files are merged again plus the new one.
  const mac = join(artifacts, "desktop-darwin-arm64");
  mkdirSync(mac);
  const zip = `Canopy-${version}-darwin-arm64.zip`;
  writeFileSync(join(mac, zip), "zip");
  const zipSha512 = new Bun.CryptoHasher("sha512").update("zip").digest("base64");
  writeFileSync(
    join(mac, "nightly-mac.yml"),
    `version: ${version}\nfiles:\n  - url: ${zip}\n    sha512: ${zipSha512}\n    size: 3\npath: ${zip}\nsha512: ${zipSha512}\n`,
  );
  const rerun = join(base, "rerun-assets");
  mkdirSync(rerun);

  for (const asset of server.assets) copyFileSync(join(assets, asset.name), join(rerun, asset.name));
  await mergeDesktopUpdates(artifacts, rerun, "nightly", version);
  const repeated = await writeReleaseFiles(rerun, env);
  expect(repeated.assets.filter((asset) => asset.name !== zip)).toEqual([...desktop.assets]);
  expect(repeated.assets.find((asset) => asset.name === zip)?.app).toBe("desktop");
  const again = await writeReleaseFiles(rerun, env);
  expect({ ...again, published_at: "" }).toEqual({ ...repeated, published_at: "" });
});
